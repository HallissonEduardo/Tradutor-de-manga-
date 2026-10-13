// Documento offscreen: recebe mensagens do service worker via chrome.runtime.
let worker = null;
let langAtual = null;
let psmAtual = null;
let fila = Promise.resolve(); // serializa o uso do worker

async function obterWorker(lang, psm) {
  if (!worker || langAtual !== lang) {
    if (worker) await worker.terminate();
    worker = await Tesseract.createWorker(lang, 1, {
      workerPath: chrome.runtime.getURL("lib/tesseract/worker.min.js"),
      corePath: chrome.runtime.getURL("lib/tesseract/"),
      langPath: chrome.runtime.getURL("lib/tesseract/lang/"),
      workerBlobURL: false,
      cacheMethod: "none"
    });
    langAtual = lang;
    psmAtual = null;
  }
  if (psmAtual !== psm) {
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    psmAtual = psm;
  }
  return worker;
}

chrome.runtime.onMessage.addListener((msg, _remetente, enviarResposta) => {
  if (msg?.target !== "offscreen" || msg.acao !== "processar_ocr") return false;

  fila = fila.then(async () => {
    try {
      const w = await obterWorker(msg.lang, msg.psm || "11");
      const { data } = await w.recognize(msg.imagemUri, {}, { text: true, blocks: true });

      // Linhas com caixa delimitadora e o bloco do Tesseract a que pertencem: o service worker
      // agrupa por bloco (análise de layout do próprio Tesseract) em vez de por proximidade.
      // Só entram palavras com confiança mínima; `confs` guarda a de TODAS, para julgar o bloco.
      const CONFIANCA_PALAVRA = 40;
      const linhas = [];
      (data.blocks || []).forEach((b, bi) => {
        (b.paragraphs || []).forEach((p, pi) => {
          for (const l of p.lines || []) {
            const palavras = (l.words || []).filter((w) => (w.text || "").trim());
            const boas = palavras.filter((w) => w.confidence >= CONFIANCA_PALAVRA && w.bbox);
            let texto, bbox;
            if (palavras.length) {
              if (!boas.length) continue;
              texto = boas.map((w) => w.text.trim()).join(" ");
              bbox = {
                x0: Math.min(...boas.map((w) => w.bbox.x0)), y0: Math.min(...boas.map((w) => w.bbox.y0)),
                x1: Math.max(...boas.map((w) => w.bbox.x1)), y1: Math.max(...boas.map((w) => w.bbox.y1))
              };
            } else if (l.bbox) { // sem detalhe por palavra: usa a linha inteira
              texto = (l.text || "").trim();
              bbox = l.bbox;
            } else continue;
            linhas.push({
              texto, bbox, bloco: bi, par: pi, confianca: l.confidence,
              confs: palavras.length ? palavras.map((w) => Math.max(0, w.confidence)) : [Math.max(0, l.confidence)]
            });
          }
        });
      });
      enviarResposta({ sucesso: true, texto: data.text.trim(), confianca: data.confidence, linhas });
    } catch (erro) {
      enviarResposta({ sucesso: false, erro: erro.message || String(erro) });
    }
  });
  return true;
});
