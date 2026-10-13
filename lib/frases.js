// Memória por frase e cache aproximado. Roda no service worker.
//
//  1. dividirFrases(): um balão com várias frases vira várias unidades de tradução. "I don't know."
//     aparece em dezenas de balões diferentes: só a frase inédita vai à API.
//  2. IndiceFrases: procura no cache por uma forma normalizada (sem caixa, pontuação e espaços) e,
//     para frases longas, por similaridade de trigramas (Dice >= 90%). O ruído do OCR
//     ("Whats going on?" x "What's going on?") deixa de gerar chamadas novas.
//     O índice é montado em memória a partir do IndexedDB (leitura única, sob demanda) e
//     mantido em dia a cada gravação.
const SIMILARIDADE_MIN = 0.9;       // coeficiente de Dice entre os conjuntos de trigramas
const MIN_NORM_TRIGRAMA = 20;       // abaixo disso (caracteres normalizados), só vale igualdade exata
const MIN_NORM_TRIGRAMA_CJK = 10;
const TOLERANCIA_COMPRIMENTO = 0.1; // diferença máxima de tamanho entre as duas formas normalizadas

const TERMINADORES = /[.!?。！？．]/;
const FECHAMENTOS = /["'”’)\]」』）】]/;
const ABREVIATURAS = new Set(["mr", "mrs", "ms", "dr", "jr", "sr", "st", "vs", "mt", "prof", "gen", "col", "capt", "lt", "sgt"]);
const BORDA_INICIO = /^[\s"'¿¡.…~-]*/;
const BORDA_FIM = /[\s"')\].!?…,;:~-]*$/;
const TEM_CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

/**
 * Divide um texto em frases. Conservador: reticências ("...", "…") NÃO encerram frase,
 * ponto de abreviatura/inicial ("Mr.", "J. Smith") e número decimal também não, e
 * fragmentos sem pelo menos 2 letras são colados à frase vizinha.
 */
function dividirFrases(texto) {
  const t = String(texto || "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  const n = t.length;
  const brutas = [];
  let ini = 0, i = 0;

  while (i < n) {
    if (!TERMINADORES.test(t[i])) { i++; continue; }
    let j = i;
    while (j < n && TERMINADORES.test(t[j])) j++;
    const grupo = t.slice(i, j);
    let k = j;
    while (k < n && FECHAMENTOS.test(t[k])) k++;

    const cjk = /[。！？．]/.test(grupo);
    let fim = true;
    if (/^\.{2,}$/.test(grupo)) fim = false;                 // reticências
    else if (!cjk && k < n && t[k] !== " ") fim = false;      // "3.5", "U.S.A", "?!abc"
    else if (grupo === ".") {
      const antes = t.slice(ini, i);
      const palavra = (antes.match(/([A-Za-z]+)$/) || [])[1] || "";
      if (ABREVIATURAS.has(palavra.toLowerCase())) fim = false;
      else if (palavra.length === 1 && palavra !== "I" && palavra === palavra.toUpperCase()) fim = false; // inicial: "J. Smith"
    }
    if (fim && k >= n) fim = false; // a última frase é fechada pelo resto, abaixo

    if (fim) {
      brutas.push(t.slice(ini, k).trim());
      ini = k;
    }
    i = k;
  }
  const resto = t.slice(ini).trim();
  if (resto) brutas.push(resto);

  // Funde fragmentos sem pelo menos 2 letras ("?!", "A.") com a frase vizinha.
  const frases = [];
  let carregado = "";
  for (const b of brutas) {
    const letras = (b.match(/\p{L}/gu) || []).length;
    if (letras < 2) {
      if (frases.length && !/\p{L}/u.test(b)) frases[frases.length - 1] += b;
      else carregado += (carregado ? " " : "") + b;
      continue;
    }
    frases.push(carregado ? `${carregado} ${b}` : b);
    carregado = "";
  }
  if (carregado) {
    if (frases.length) frases[frases.length - 1] += ` ${carregado}`;
    else frases.push(carregado);
  }
  return frases.length ? frases : [t];
}

/** Forma normalizada: sem caixa, pontuação, espaços (NFKC unifica largura total e compatibilidades). */
function normalizarFrase(texto) {
  return String(texto || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function trigramas(norm) {
  const s = new Set();
  for (let i = 0; i + 3 <= norm.length; i++) s.add(norm.slice(i, i + 3));
  return s;
}

// Duas frases quase iguais mas com negação ou números diferentes NÃO são a mesma frase.
const RE_NEGACAO = /\b(?:not|no|never|nothing|nobody|none|cannot|without)\b|n['’]t\b|\b(?:dont|cant|wont|didnt|doesnt|isnt|arent|wasnt|couldnt|wouldnt|shouldnt)\b/g;
function assinaturaSemantica(texto) {
  const t = String(texto || "").normalize("NFKC").toLowerCase();
  return `${(t.match(RE_NEGACAO) || []).length}|${(t.match(/\d+/g) || []).join(",")}`;
}

/** Reaplica a pontuação das pontas da consulta (OCR) sobre a tradução guardada. */
function reaplicarPontuacao(traduzida, consulta) {
  const tr = String(traduzida);
  const iniT = tr.match(BORDA_INICIO)[0];
  const fimT = tr.slice(iniT.length).match(BORDA_FIM)[0];
  const miolo = tr.slice(iniT.length, tr.length - fimT.length);
  if (!miolo) return tr;
  const q = DicionarioFalas.partir(consulta);
  return (q.prefixo || iniT.trim()) + miolo + (q.sufixo || fimT.trim());
}

class IndiceFrases {
  constructor(cache) {
    this.cache = cache;
    this._carga = null;
    this.grupos = new Map(); // prefixo da chave ("en>pt-BR", "en>pt-BR@deepl") -> { exato, entradas, tri }
  }

  invalidar() {
    this._carga = null;
    this.grupos = new Map();
  }

  carregar() {
    this._carga ??= this.cache.exportarTextos()
      .then((itens) => {
        this.grupos = new Map();
        for (const { k, v } of itens) this._inserir(k, v);
      })
      .catch(() => { this._carga = null; });
    return this._carga;
  }

  /** Mantém o índice em dia após gravar no cache. */
  async adicionar(chave, traducao) {
    await this.carregar();
    this._inserir(chave, traducao);
  }

  _inserir(chave, traducao) {
    const p = chave.indexOf("\x1f");
    if (p < 0 || !String(traducao || "").trim()) return;
    const prefixo = chave.slice(0, p), original = chave.slice(p + 1);
    const norm = normalizarFrase(original);
    if (norm.length < 2) return;

    let g = this.grupos.get(prefixo);
    if (!g) this.grupos.set(prefixo, (g = { exato: new Map(), entradas: [], tri: new Map() }));
    if (g.exato.has(norm)) return; // mantém a primeira tradução guardada para a mesma forma

    const entrada = { trad: String(traducao), norm, sem: assinaturaSemantica(original), n: 0 };
    g.exato.set(norm, entrada);

    if (norm.length >= (TEM_CJK.test(norm) ? MIN_NORM_TRIGRAMA_CJK : MIN_NORM_TRIGRAMA)) {
      const tg = trigramas(norm);
      entrada.n = tg.size;
      const id = g.entradas.push(entrada) - 1;
      for (const t of tg) {
        const lista = g.tri.get(t);
        if (lista) lista.push(id); else g.tri.set(t, [id]);
      }
    }
  }

  /**
   * Procura `frase` nos grupos indicados (um por provedor). Devolve a tradução (com a pontuação da
   * consulta) ou null. Primeiro igualdade normalizada; depois, para frases longas, trigramas.
   */
  async buscar(prefixos, frase) {
    await this.carregar();
    const norm = normalizarFrase(frase);
    if (norm.length < 2) return null;
    const grupos = prefixos.map((p) => this.grupos.get(p)).filter(Boolean);
    if (!grupos.length) return null;

    for (const g of grupos) {
      const e = g.exato.get(norm);
      if (e) return reaplicarPontuacao(e.trad, frase);
    }

    if (norm.length < (TEM_CJK.test(norm) ? MIN_NORM_TRIGRAMA_CJK : MIN_NORM_TRIGRAMA)) return null;
    const q = trigramas(norm);
    const sem = assinaturaSemantica(frase);
    let melhor = null, nota = 0;
    for (const g of grupos) {
      const comuns = new Map();
      for (const t of q) {
        const ids = g.tri.get(t);
        if (ids) for (const id of ids) comuns.set(id, (comuns.get(id) || 0) + 1);
      }
      for (const [id, c] of comuns) {
        const e = g.entradas[id];
        if (Math.abs(e.norm.length - norm.length) > TOLERANCIA_COMPRIMENTO * Math.max(e.norm.length, norm.length)) continue;
        const dice = (2 * c) / (q.size + e.n);
        if (dice >= SIMILARIDADE_MIN && dice > nota && e.sem === sem) { melhor = e; nota = dice; }
      }
    }
    return melhor ? reaplicarPontuacao(melhor.trad, frase) : null;
  }
}
