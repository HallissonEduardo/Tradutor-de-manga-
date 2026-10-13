// Contadores de quanto foi resolvido em cada degrau da cadeia de tradução. Roda no service worker.
// Persistidos em storage.local (sobrevivem ao service worker ser encerrado) e exibidos nas Opções.
//
//  frases:   uma contagem por FRASE traduzida (ocorrência), pelo degrau que a resolveu:
//            dicionario | cache | aproximado | ruido (local: sem letras, passa como está)
//            | deepl | gemini | mymemory | gemini_imagem (leitura+tradução pelo Gemini visão)
//  capturas: como cada captura foi lida: ocr | ocr_reforco (precisou de 2ª/3ª passada do OCR)
//            | cache_imagem | gemini_visao | vazias
//  chamadas: requisições de verdade feitas às APIs (a parte que custa): deepl | gemini |
//            mymemory | gemini_visao
//  caracteres: texto enviado por provedor
const CHAVE_METRICAS = "metricasTraducao";

class Metricas {
  constructor() {
    this.dados = null;
    this._carga = null;
    this._timer = null;
  }

  static vazio() {
    return { desde: Date.now(), frases: {}, capturas: {}, chamadas: {}, caracteres: {} };
  }

  _carregar() {
    this._carga ??= chrome.storage.local.get(CHAVE_METRICAS)
      .then((r) => (this.dados = Object.assign(Metricas.vazio(), r?.[CHAVE_METRICAS] || {})))
      .catch(() => (this.dados = Metricas.vazio()));
    return this._carga;
  }

  /** Soma `n` ao contador `grupo.chave`. Nunca lança: métrica não pode derrubar a tradução. */
  async somar(grupo, chave, n = 1) {
    try {
      const d = await this._carregar();
      d[grupo] ??= {};
      d[grupo][chave] = (d[grupo][chave] || 0) + n;
      this._agendar();
    } catch { /* ignora */ }
  }

  async resumo() {
    return JSON.parse(JSON.stringify(await this._carregar()));
  }

  async zerar() {
    await this._carregar();
    this.dados = Metricas.vazio();
    this._carga = Promise.resolve(this.dados);
    clearTimeout(this._timer);
    this._timer = null;
    await chrome.storage.local.set({ [CHAVE_METRICAS]: this.dados });
  }

  _agendar() {
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.persistir().catch(() => {}); }, 1000);
  }

  async persistir() {
    if (!this.dados) return;
    clearTimeout(this._timer);
    this._timer = null;
    await chrome.storage.local.set({ [CHAVE_METRICAS]: this.dados });
  }
}
