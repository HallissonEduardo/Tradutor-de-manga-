// Utilitários de imagem para o service worker (sem DOM): usa createImageBitmap e OffscreenCanvas.
class RecortadorImagem {
  /**
   * Recorta a região selecionada de uma captura da aba.
   * A escala é calculada pela largura real da captura / largura da viewport,
   * o que é robusto a zoom do navegador e monitores HiDPI.
   */
  static async recortar(imagemDataUri, coords, larguraViewport) {
    const blobOrigem = await (await fetch(imagemDataUri)).blob();
    const bitmap = await createImageBitmap(blobOrigem);
    try {
      const ratio = bitmap.width / larguraViewport;
      const sx = Math.min(Math.max(Math.round(coords.x * ratio), 0), bitmap.width - 1);
      const sy = Math.min(Math.max(Math.round(coords.y * ratio), 0), bitmap.height - 1);
      const sw = Math.min(Math.max(Math.round(coords.largura * ratio), 1), bitmap.width - sx);
      const sh = Math.min(Math.max(Math.round(coords.altura * ratio), 1), bitmap.height - sy);

      const canvas = new OffscreenCanvas(sw, sh);
      canvas.getContext("2d").drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
      return await canvas.convertToBlob({ type: "image/png" });
    } finally {
      bitmap.close();
    }
  }

  /**
   * Assinatura visual (64x64, tons de cinza) da região, usada para detectar troca de página
   * sem custo de codificar PNG a cada verificação.
   */
  static async assinaturaDaRegiao(imagemDataUri, coords, larguraViewport) {
    const bitmap = await createImageBitmap(await (await fetch(imagemDataUri)).blob());
    try {
      const ratio = bitmap.width / larguraViewport;
      const sx = Math.min(Math.max(Math.round(coords.x * ratio), 0), bitmap.width - 1);
      const sy = Math.min(Math.max(Math.round(coords.y * ratio), 0), bitmap.height - 1);
      const sw = Math.min(Math.max(Math.round(coords.largura * ratio), 1), bitmap.width - sx);
      const sh = Math.min(Math.max(Math.round(coords.altura * ratio), 1), bitmap.height - sy);

      const N = 64;
      const canvas = new OffscreenCanvas(N, N);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, N, N);
      const d = ctx.getImageData(0, 0, N, N).data;
      const saida = new Uint8Array(N * N);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        saida[j] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
      }
      return saida;
    } finally {
      bitmap.close();
    }
  }

  /** Fração (0..1) de pixels que diferem mais que `limiarPixel` entre duas assinaturas. */
  static distanciaAssinaturas(a, b, limiarPixel = 24) {
    let diferentes = 0;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > limiarPixel) diferentes++;
    return diferentes / a.length;
  }

  /**
   * Amplia, converte para tons de cinza e estica o contraste (melhora o Tesseract).
   * `inverter`: para balões escuros com texto claro.
   * `binario`: limiar de Otsu (preto e branco puro): ajuda em texto fino, fundo sujo ou JPEG ruim.
   * As passadas de reforço do OCR usam essas variações quando a primeira leitura sai fraca.
   */
  static async prepararParaOcr(blob, escala = 2, inverter = false, binario = false) {
    const bmp = await createImageBitmap(blob);
    const esc = Math.max(1, Math.min(escala, 3000 / bmp.width));
    const w = Math.round(bmp.width * esc);
    const h = Math.round(bmp.height * esc);

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();

    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    let min = 255, max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const g = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
      d[i] = d[i + 1] = d[i + 2] = g;
      if (g < min) min = g;
      if (g > max) max = g;
    }
    const faixa = Math.max(1, max - min);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i + 1] = d[i + 2] = ((d[i] - min) * 255) / faixa;
    }
    const limiar = binario ? RecortadorImagem.limiarOtsu(d) : -1;
    if (limiar >= 0 || inverter) {
      for (let i = 0; i < d.length; i += 4) {
        let v = d[i];
        if (limiar >= 0) v = v > limiar ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = inverter ? 255 - v : v;
      }
    }
    ctx.putImageData(img, 0, 0);

    const saida = await canvas.convertToBlob({ type: "image/png" });
    return {
      dataUri: "data:image/png;base64," + (await RecortadorImagem.blobParaBase64(saida)),
      largura: w,
      altura: h,
      escala: esc
    };
  }

  /** Limiar de Otsu sobre o canal vermelho (imagem já em tons de cinza). */
  static limiarOtsu(d) {
    const h = new Array(256).fill(0);
    let total = 0, soma = 0;
    for (let i = 0; i < d.length; i += 4) { h[d[i]]++; total++; }
    for (let t = 0; t < 256; t++) soma += t * h[t];
    let somaB = 0, wB = 0, melhor = -1, limiar = 127;
    for (let t = 0; t < 256; t++) {
      wB += h[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      somaB += t * h[t];
      const mB = somaB / wB, mF = (soma - somaB) / wF;
      const v = wB * wF * (mB - mF) ** 2;
      if (v > melhor) { melhor = v; limiar = t; }
    }
    return limiar;
  }

  /**
   * Descobre a cor de fundo de cada balão (mediana por canal da região central) e uma cor de
   * texto com bom contraste. Preenche item.fundo e item.cor.
   */
  static async amostrarCores(blob, itens) {
    const bmp = await createImageBitmap(blob);
    try {
      const esc = Math.min(1, 1000 / bmp.width);
      const W = Math.max(1, Math.round(bmp.width * esc));
      const H = Math.max(1, Math.round(bmp.height * esc));
      const canvas = new OffscreenCanvas(W, H);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0, W, H);

      const mediana = (a) => a.sort((p, q) => p - q)[a.length >> 1];
      for (const it of itens) {
        const { x, y, w, h } = it.caixa;
        const sx = Math.min(W - 1, Math.floor((x + w * 0.15) * W));
        const sy = Math.min(H - 1, Math.floor((y + h * 0.15) * H));
        const sw = Math.max(1, Math.min(W - sx, Math.floor(w * 0.7 * W)));
        const sh = Math.max(1, Math.min(H - sy, Math.floor(h * 0.7 * H)));
        const d = ctx.getImageData(sx, sy, sw, sh).data;
        const passo = Math.max(1, Math.floor(d.length / 4 / 1500));
        const R = [], G = [], B = [];
        for (let i = 0; i < d.length; i += 4 * passo) { R.push(d[i]); G.push(d[i + 1]); B.push(d[i + 2]); }
        const r = mediana(R), g = mediana(G), b = mediana(B);
        it.fundo = `rgb(${r}, ${g}, ${b})`;
        it.cor = 0.299 * r + 0.587 * g + 0.114 * b > 140 ? "#111111" : "#ffffff";
      }
    } finally {
      bmp.close();
    }
  }

  static async blobParaBase64(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    const passo = 0x8000;
    for (let i = 0; i < buf.length; i += passo) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + passo));
    }
    return btoa(bin);
  }

  static async sha256(blob) {
    const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
}
