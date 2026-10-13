importScripts(
  "../lib/db_cache.js", "../lib/recorte_imagem.js", "../lib/tradutor.js", "../lib/dicionario.js",
  "../lib/frases.js", "../lib/metricas.js"
);

const cache = new CacheIndexedDB();
const tradutor = new ServicoTraducao();
const dicionario = new DicionarioFalas(); // falas frequentes: consultado antes do cache e das APIs
const indice = new IndiceFrases(cache);   // cache aproximado (forma normalizada + trigramas)
const metricas = new Metricas();          // quanto cada degrau da cadeia resolveu
const capturas = new Map(); // capturaId -> { blob, base64, hash, t }
const monitores = new Map(); // tabId -> { ref, pendente } (modo automático)

// Modo automático: sensibilidade da detecção de troca de página (fração de pixels diferentes)
const LIMIAR_MUDANCA = 0.02; // acima disso, a área mudou em relação à última página traduzida
const LIMIAR_ESTAVEL = 0.004; // abaixo disso entre duas leituras seguidas, a imagem "assentou"

// Confiança média PONDERADA (por letras) dos blocos aceitos. Abaixo disso o OCR tenta uma passada de
// reforço (binarizada, depois invertida) e, se ainda ficar fraco, o Gemini (visão) é a reserva.
// Antes era a confiança da página inteira, que a arte lida como letras puxava para baixo e
// disparava o Gemini sem necessidade. Ajuste olhando as Estatísticas nas Opções.
const CONFIANCA_MINIMA = 70;
const CONFIANCA_BLOCO = 55;   // blocos do Tesseract com média de palavras abaixo disso são arte lida como letras
const MARGEM_PX = 4;          // folga ao redor do texto (em pixels da captura original)
const LIMITE_MONITOR_POR_MIN = 30; // trava anti-loop do modo automático (traduções novas por minuto)
const temposMonitor = [];
const IDIOMAS_OCR = { en: "eng", ja: "jpn", es: "spa", ko: "kor", zh: "chi_sim" };

// ---------- Migração: chaves antigas estavam em storage.sync (sincroniza com a conta Google) ----------
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const antigo = await chrome.storage.sync.get(CHAVES_CONFIG);
    if (!Object.keys(antigo).length) return;
    const atual = await chrome.storage.local.get(CHAVES_CONFIG);
    await chrome.storage.local.set({ ...antigo, ...atual });
    await chrome.storage.sync.remove(CHAVES_CONFIG);
  } catch (e) { console.warn("Migração de configurações falhou:", e); }
});

// ---------- Injeção sob demanda (clique no ícone ou Alt+T) ----------
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/overlay.js"] });
  } catch (erro) {
    console.warn("Não foi possível ativar nesta página:", erro.message);
    chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: "" }), 2500);
  }
});

// ---------- Documento offscreen (Tesseract) ----------
let criandoOffscreen = null;
async function garantirOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (ctx.length) return;
  criandoOffscreen ??= chrome.offscreen
    .createDocument({
      url: "pages/ocr.html",
      reasons: ["WORKERS"],
      justification: "Executar Tesseract.js (WebAssembly) para OCR."
    })
    .finally(() => { criandoOffscreen = null; });
  await criandoOffscreen;
}

function comTimeout(promessa, ms, msg) {
  let timer;
  return Promise.race([
    promessa,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(msg)), ms); })
  ]).finally(() => clearTimeout(timer));
}

async function executarOcr(captura, cfg, { inverter = false, binario = false } = {}) {
  await garantirOffscreen();
  const prep = await RecortadorImagem.prepararParaOcr(captura.blob, 2, inverter, binario);
  const vertical = cfg.origem === "ja" && cfg.japonesVertical;
  const lang = vertical ? "jpn_vert" : IDIOMAS_OCR[cfg.origem] || "eng";
  // Vertical: bloco único; demais: análise automática de layout (PSM 3), que separa os balões
  // em blocos coerentes. O PSM 11 (texto esparso) fragmentava cada balão em pedaços soltos.
  const psm = vertical ? "5" : "3";

  const r = await comTimeout(
    chrome.runtime.sendMessage({ target: "offscreen", acao: "processar_ocr", imagemUri: prep.dataUri, lang, psm }),
    90000,
    "O OCR demorou demais."
  );
  if (!r?.sucesso) throw new Error(r?.erro || "Falha no OCR.");
  return { ...r, largura: prep.largura, altura: prep.altura, escala: prep.escala, vertical };
}

/**
 * Agrupa as linhas do Tesseract em balões pelo BLOCO que o próprio Tesseract identificou
 * (sem fusão por proximidade: ela encadeava balões vizinhos num bloco gigante).
 * Descarta blocos de confiança baixa (arte lida como letras) e ruído.
 */
function montarItensOcr(ocr) {
  const W = ocr.largura, H = ocr.altura;
  const margem = Math.max(2, Math.round(MARGEM_PX * (ocr.escala || 1)));

  const blocos = new Map();
  for (const l of ocr.linhas || []) {
    if (!l.texto || !/[\p{L}\p{N}]/u.test(l.texto)) continue;
    if (!blocos.has(l.bloco)) blocos.set(l.bloco, []);
    blocos.get(l.bloco).push(l);
  }

  const itens = [];
  for (const g of blocos.values()) {
    const confs = g.flatMap((l) => l.confs || []);
    const media = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
    if (media < CONFIANCA_BLOCO) continue;

    if (ocr.vertical) g.sort((a, b) => b.bbox.x0 - a.bbox.x0 || a.bbox.y0 - b.bbox.y0);
    const original = tradutor.normalizarTexto(g.map((l) => l.texto).join(" "));
    const alfanumericos = (original.match(/[\p{L}\p{N}]/gu) || []).length;
    if (alfanumericos < 2) continue;

    const x0 = Math.min(...g.map((l) => l.bbox.x0)), x1 = Math.max(...g.map((l) => l.bbox.x1));
    const y0 = Math.min(...g.map((l) => l.bbox.y0)), y1 = Math.max(...g.map((l) => l.bbox.y1));
    const bx0 = Math.max(0, x0 - margem), by0 = Math.max(0, y0 - margem);
    const bx1 = Math.min(W, x1 + margem), by1 = Math.min(H, y1 + margem);
    itens.push({
      original,
      confianca: media,
      letras: alfanumericos,
      caixa: { x: bx0 / W, y: by0 / H, w: (bx1 - bx0) / W, h: (by1 - by0) / H }
    });
  }

  itens.sort(ocr.vertical
    ? (a, b) => b.caixa.x - a.caixa.x
    : (a, b) => a.caixa.y - b.caixa.y || a.caixa.x - b.caixa.x);
  return itens;
}

/** Confiança média ponderada por letras e "pontos" (letras x confiança) para comparar passadas do OCR. */
function notaOcr(itens) {
  let letras = 0, pontos = 0;
  for (const i of itens) { letras += i.letras; pontos += i.letras * i.confianca; }
  return { media: letras ? pontos / letras : 0, pontos };
}

// ---------- Fluxos ----------
// Resultado: { itens: [{ texto, original, tipo, caixa:{x,y,w,h} (frações), fundo, cor }], cache? }

/**
 * Chave do cache por texto, separada por provedor. O Gemini mantém o formato legado
 * ("origem>destino\x1ftexto", compatível com o desktop e com os dados já gravados);
 * os demais acrescentam "@provedor" ao par de idiomas ("origem>destino@deepl\x1ftexto").
 */
const PROVEDORES_CACHE = ["deepl", "gemini"];
const chaveTexto = (cfg, texto, provedor = "gemini") =>
  CacheIndexedDB.chaveTexto(cfg.origem, provedor === "gemini" ? cfg.destino : `${cfg.destino}@${provedor}`, texto);

/** Procura a tradução de um texto no cache de qualquer provedor (cada um na sua própria chave). */
async function buscarTextoEmCache(cfg, texto) {
  for (const p of PROVEDORES_CACHE) {
    const v = await cache.buscar(chaveTexto(cfg, texto, p)).catch(() => null);
    if (v) return v;
  }
  return null;
}

/**
 * Guarda uma frase traduzida: cache por texto (chave do provedor), índice aproximado e, se for
 * curta, o dicionário aprendido. Não bloqueia quem chama.
 */
function guardarFrase(cfg, original, traducao, provedor) {
  const chave = chaveTexto(cfg, original, provedor);
  cache.salvar(chave, traducao).then(() => indice.adicionar(chave, traducao)).catch(() => {});
  dicionario.aprender(cfg.origem, cfg.destino, original, traducao).catch(() => {});
}

/**
 * Guarda o resultado de um balão inteiro (lido e traduzido pelo Gemini) frase a frase, quando
 * original e tradução têm o mesmo número de frases; balão de uma frase só guarda o par inteiro.
 */
function guardarPares(cfg, original, traducao, provedor) {
  const fo = dividirFrases(original), ft = dividirFrases(traducao);
  const pares = fo.length === ft.length ? fo.map((f, i) => [f, ft[i]]) : fo.length === 1 ? [[original, traducao]] : [];
  for (const [o, t] of pares) {
    if (!t.trim() || tradutor.eRuido(o)) continue;
    guardarFrase(cfg, o, t, provedor);
  }
}

/** Uma única requisição: o Gemini detecta, lê e traduz todos os balões da imagem. */
async function fluxoGemini(captura, cfg, { soCache = false } = {}) {
  const chave = `img2|${cfg.origem}|${cfg.destino}|${cfg.modelo}|${captura.hash}`;
  const emCache = await cache.buscar(chave);
  if (emCache) {
    const itens = JSON.parse(emCache);
    metricas.somar("capturas", "cache_imagem");
    metricas.somar("frases", "cache", itens.length);
    return { itens, cache: true };
  }
  if (soCache) return null; // Gemini bloqueado (429): só vale o que já está no cache

  const itens = await tradutor.traduzirImagem(captura, cfg);
  metricas.somar("chamadas", "gemini_visao");
  if (!itens.length) {
    metricas.somar("capturas", "vazias");
    throw new Error("Nenhum texto encontrado na área selecionada.");
  }
  metricas.somar("capturas", "gemini_visao");
  metricas.somar("frases", "gemini_imagem", itens.length);
  await RecortadorImagem.amostrarCores(captura.blob, itens);
  await cache.salvar(chave, JSON.stringify(itens));
  // Também alimenta o cache por frase: reaproveitado em outras páginas, modos e no desktop.
  for (const it of itens) {
    const original = tradutor.normalizarTexto(it.original || "");
    if (original && !tradutor.eRuido(original)) guardarPares(cfg, original, it.texto, "gemini");
  }
  return { itens };
}

/**
 * Traduz os textos dos balões FRASE A FRASE. Cada frase passa pelos degraus, do mais barato ao mais
 * caro: dicionário → cache exato → cache aproximado → API (DeepL → Gemini → MyMemory). Frases
 * repetidas (na página ou entre balões) vão uma única vez à API. Devolve a tradução de cada balão.
 */
async function traduzirBaloes(originais, cfg) {
  const porBalao = originais.map((o) => dividirFrases(o));
  const prefixos = PROVEDORES_CACHE.map((p) => chaveTexto(cfg, "", p).slice(0, -1));
  const memo = new Map(); // frase -> { t, fonte }
  const pendentes = [];

  for (const frase of new Set(porBalao.flat())) {
    if (tradutor.eRuido(frase)) { memo.set(frase, { t: frase, fonte: "ruido" }); continue; }
    const degraus = [
      ["dicionario", () => dicionario.buscar(cfg.origem, cfg.destino, frase)],
      ["cache", () => buscarTextoEmCache(cfg, frase)],
      ["aproximado", () => indice.buscar(prefixos, frase)]
    ];
    let achou = false;
    for (const [fonte, buscar] of degraus) {
      const t = await buscar().catch(() => null);
      if (t) { memo.set(frase, { t, fonte }); achou = true; break; }
    }
    if (!achou) pendentes.push(frase);
  }

  let tudoSemApi = true;
  if (pendentes.length) {
    tudoSemApi = false;
    const r = await tradutor.traduzirLote(pendentes, cfg);
    pendentes.forEach((f, n) => memo.set(f, { t: r.textos[n], fonte: r.origem }));
    metricas.somar("chamadas", r.origem, r.origem === "deepl" ? Math.ceil(pendentes.length / LOTE_DEEPL) : r.origem === "mymemory" ? pendentes.length : 1);
    metricas.somar("caracteres", r.origem, pendentes.reduce((s, f) => s + f.length, 0));
    // O MyMemory é só um quebra-galho: não cacheia (senão Gemini/DeepL nunca refariam a tradução).
    if (r.origem === "gemini" || r.origem === "deepl") {
      pendentes.forEach((f, n) => guardarFrase(cfg, f, r.textos[n], r.origem));
    }
  }

  const traducoes = porBalao.map((frases) =>
    frases.map((f) => {
      const m = memo.get(f);
      metricas.somar("frases", m.fonte);
      return m.t;
    }).join(" ")
  );
  return { traducoes, tudoSemApi };
}

/**
 * OCR local por bloco + tradução frase a frase. Se a primeira leitura sai fraca, o OCR tenta
 * passadas de reforço (binarizada, invertida) e fica com a melhor, para o Gemini (visão, a chamada
 * mais cara) ser só reserva.
 */
async function fluxoTesseract(captura, cfg) {
  const passadas = [{}, { binario: true }, { inverter: true }];
  let melhor = null, erroOcr = null;
  for (const [n, opcoes] of passadas.entries()) {
    try {
      const ocr = await executarOcr(captura, cfg, opcoes);
      const lidos = montarItensOcr(ocr);
      const nota = notaOcr(lidos);
      if (!melhor || nota.pontos > melhor.nota.pontos) melhor = { lidos, nota, passada: n };
      if (lidos.length && nota.media >= CONFIANCA_MINIMA) break; // leitura boa: sem reforço
    } catch (erro) {
      erroOcr = erro;
      break;
    }
  }

  if (!melhor) {
    // OCR local indisponível: a visão do Gemini lê a imagem (o DeepL só traduz texto).
    // Com o Gemini bloqueado por 429, não há chamada: só o cache de imagem é consultado.
    if (!cfg.apiKey) throw erroOcr;
    console.warn("OCR local falhou, tentando Gemini (imagem):", erroOcr.message);
    const r = await fluxoGemini(captura, cfg, { soCache: !(await tradutor.geminiDisponivel(cfg)) });
    if (!r) throw erroOcr;
    return r;
  }

  const { lidos, nota } = melhor;
  if ((!lidos.length || nota.media < CONFIANCA_MINIMA) && cfg.apiKey) {
    try {
      // Gemini bloqueado (429): nenhuma requisição; usa só o cache de imagem, se houver.
      const r = await fluxoGemini(captura, cfg, { soCache: !(await tradutor.geminiDisponivel(cfg)) });
      if (r) return r;
    } catch (e) {
      if (!lidos.length) throw e; // sem nenhum texto, o erro real é mais útil que "nada encontrado"
      console.warn("Gemini falhou; mantendo o resultado do Tesseract:", e.message);
    }
  }
  if (!lidos.length) {
    metricas.somar("capturas", "vazias");
    throw new Error("Nenhum texto encontrado na área selecionada.");
  }

  metricas.somar("capturas", "ocr");
  if (melhor.passada > 0) metricas.somar("capturas", "ocr_reforco");
  const { traducoes, tudoSemApi } = await traduzirBaloes(lidos.map((i) => i.original), cfg);
  const itens = lidos.map((it, i) => ({
    texto: traducoes[i], original: it.original, tipo: "fala", forma: "retangulo", caixa: it.caixa
  }));
  await RecortadorImagem.amostrarCores(captura.blob, itens);
  return { itens, cache: tudoSemApi };
}

// ---------- Handlers de mensagens ----------
async function guardarCaptura(blob) {
  const agora = Date.now();
  for (const [id, c] of capturas) if (agora - c.t > 120000) capturas.delete(id);

  const capturaId = crypto.randomUUID();
  capturas.set(capturaId, {
    blob,
    mimeType: "image/png",
    base64: await RecortadorImagem.blobParaBase64(blob),
    hash: await RecortadorImagem.sha256(blob),
    t: agora
  });
  return capturaId;
}

async function capturarArea(msg, sender) {
  if (!sender.tab) throw new Error("Origem da mensagem inválida.");
  const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
  const blob = await RecortadorImagem.recortar(dataUrl, msg.coords, msg.viewportWidth);
  return { capturaId: await guardarCaptura(blob) };
}

/**
 * Modo automático: compara a região monitorada com a última página traduzida.
 * Só devolve uma captura quando a imagem mudou E ficou estável (evita traduzir
 * animações de transição ou páginas ainda carregando).
 */
async function monitorVerificar(msg, sender) {
  if (!sender.tab) throw new Error("Origem da mensagem inválida.");
  const tabId = sender.tab.id;
  const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
  const assinatura = await RecortadorImagem.assinaturaDaRegiao(dataUrl, msg.coords, msg.viewportWidth);

  let est = monitores.get(tabId);
  if (msg.forcar || !est) {
    est = { ref: null, pendente: null };
    monitores.set(tabId, est);
  }

  const dist = RecortadorImagem.distanciaAssinaturas;
  if (est.ref && dist(assinatura, est.ref) < LIMIAR_MUDANCA) {
    est.pendente = null;
    return { estado: "igual" };
  }

  if (est.pendente && dist(assinatura, est.pendente) < LIMIAR_ESTAVEL) {
    const agora = Date.now();
    while (temposMonitor.length && agora - temposMonitor[0] > 60000) temposMonitor.shift();
    if (temposMonitor.length >= LIMITE_MONITOR_POR_MIN) return { estado: "limitado" };
    temposMonitor.push(agora);
    est.ref = assinatura;
    est.pendente = null;
    const blob = await RecortadorImagem.recortar(dataUrl, msg.coords, msg.viewportWidth);
    return { estado: "novo", capturaId: await guardarCaptura(blob) };
  }

  est.pendente = assinatura;
  return { estado: "instavel" };
}

async function processarCaptura(msg) {
  const captura = capturas.get(msg.capturaId);
  if (!captura) throw new Error("A captura expirou. Selecione a área novamente.");
  capturas.delete(msg.capturaId);

  const cfg = await tradutor.obterConfiguracoes();
  // OCR local lê os balões; cada frase é resolvida por dicionário → cache → cache aproximado →
  // DeepL → Gemini (→ MyMemory, conforme o modo). O Gemini também lê a imagem quando o OCR
  // não encontra texto confiável.
  try {
    return await fluxoTesseract(captura, cfg);
  } finally {
    await metricas.persistir().catch(() => {});
  }
}

async function testarDeepl(msg) {
  const chave = (msg.chave || "").trim();
  if (!chave) throw new Error("Cole a chave do DeepL antes de testar.");
  return tradutor.usoDeepl(chave);
}

async function testarChave(msg) {
  const cfg = await tradutor.obterConfiguracoes();
  const resposta = await tradutor.chamarGemini(
    { ...cfg, apiKey: (msg.apiKey || "").trim(), modelo: msg.modelo || cfg.modelo },
    [{ text: "Responda apenas: ok" }],
    undefined, {}, { ignorarBloqueio: true }
  );
  return { texto: resposta };
}

chrome.runtime.onMessage.addListener((msg, sender, enviarResposta) => {
  const rotas = {
    cache_exportar: async () => ({ itens: await cache.exportarTextos() }),
    cache_importar: async () => { const novos = await cache.importarTextos(msg.itens); indice.invalidar(); return { novos }; },
    cache_limpar: async () => { await cache.limpar(); indice.invalidar(); return {}; },
    metricas_info: async () => ({ dados: await metricas.resumo() }),
    metricas_zerar: async () => { await metricas.zerar(); return {}; },
    dicionario_info: () => dicionario.info(),
    dicionario_limpar: async () => { await dicionario.limparAprendidas(); return {}; },
    capturar_area: () => capturarArea(msg, sender),
    processar_captura: () => processarCaptura(msg),
    testar_chave: () => testarChave(msg),
    testar_deepl: () => testarDeepl(msg),
    monitor_verificar: () => monitorVerificar(msg, sender),
    monitor_parar: async () => { if (sender.tab) monitores.delete(sender.tab.id); return {}; }
  };
  const rota = rotas[msg?.acao];
  if (!rota) return false;

  rota()
    .then((r) => enviarResposta({ sucesso: true, ...r }))
    .catch((e) => enviarResposta({ sucesso: false, erro: e?.message || String(e) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => monitores.delete(tabId));
