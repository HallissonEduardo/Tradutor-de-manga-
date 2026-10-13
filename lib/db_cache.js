// Cache de traduções (IndexedDB). Roda no service worker, ou seja, na origem da extensão:
// é ÚNICO para todos os sites (não fragmenta por site nem por pasta) e inacessível às páginas.
//
// Dois tipos de chave no mesmo store:
//  - texto:  "<origem>><destino>\x1f<texto original>"  (mesmo formato do cache SQLite da versão
//            desktop, o que permite exportar/importar entre as duas versões)
//  - imagem: "img2|<origem>|<destino>|<modelo>|<hash>" (resultado completo de uma captura)
class CacheIndexedDB {
  constructor() {
    this.nomeDb = "TradutorMangaDB";
    this.versao = 1;
    this.storeName = "cache_traducao";
    this.limite = 10000; // máximo de entradas; as menos usadas são removidas (LRU)
    this._dbPromise = null;
    this._salvamentos = 0;
  }

  /** Chave do cache por texto (formato compartilhado com o desktop). */
  static chaveTexto(origem, destino, texto) {
    return `${origem}>${destino}\x1f${texto}`;
  }

  abrir() {
    if (!this._dbPromise) {
      this._dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(this.nomeDb, this.versao);
        request.onerror = () => { this._dbPromise = null; reject(request.error); };
        request.onsuccess = () => {
          const db = request.result;
          db.onclose = () => { this._dbPromise = null; };
          db.onversionchange = () => { db.close(); this._dbPromise = null; };
          resolve(db);
        };
        request.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            const store = db.createObjectStore(this.storeName);
            store.createIndex("t", "t");
          }
        };
      });
    }
    return this._dbPromise;
  }

  /**
   * Lê uma entrada (transação somente-leitura, como era antes). O carimbo de uso, que a poda LRU
   * usa, só é renovado se tiver mais de 1 hora: no uso normal a leitura não escreve nada.
   */
  async buscar(chave) {
    const db = await this.abrir();
    const r = await new Promise((resolve, reject) => {
      const req = db.transaction(this.storeName, "readonly").objectStore(this.storeName).get(chave);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (!r) return null;
    if (Date.now() - (r.t || 0) > 3600000) {
      db.transaction(this.storeName, "readwrite").objectStore(this.storeName)
        .put({ texto: r.texto, t: Date.now() }, chave);
    }
    return r.texto;
  }

  async salvar(chave, texto) {
    if (!String(texto || "").trim()) return; // nunca grava tradução vazia
    const db = await this.abrir();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      tx.objectStore(this.storeName).put({ texto, t: Date.now() }, chave);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
    if (++this._salvamentos % 50 === 0) this.podar().catch(() => {});
  }

  /** Remove as entradas menos usadas que excedem o limite. */
  async podar() {
    const db = await this.abrir();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const contagem = store.count();
      contagem.onsuccess = () => {
        let excedente = contagem.result - this.limite;
        if (excedente <= 0) return;
        const cursor = store.index("t").openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (c && excedente-- > 0) { c.delete(); c.continue(); }
        };
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Exporta só o cache por texto (o de imagem é específico desta extensão): [{k, v}]. */
  async exportarTextos() {
    const db = await this.abrir();
    return new Promise((resolve, reject) => {
      const saida = [];
      const tx = db.transaction(this.storeName, "readonly");
      tx.objectStore(this.storeName).openCursor().onsuccess = (e) => {
        const c = e.target.result;
        if (!c) return;
        if (typeof c.key === "string" && c.key.includes("\x1f")) saida.push({ k: c.key, v: c.value.texto });
        c.continue();
      };
      tx.oncomplete = () => resolve(saida);
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Importa [{k, v}]; não sobrescreve entradas já existentes. Devolve quantas entraram. */
  async importarTextos(itens) {
    const validos = (itens || []).filter(
      (i) => i && typeof i.k === "string" && i.k.includes("\x1f") && String(i.v || "").trim()
    );
    const db = await this.abrir();
    return new Promise((resolve, reject) => {
      let novos = 0;
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const agora = Date.now();
      for (const { k, v } of validos) {
        store.add({ texto: String(v), t: agora }, k).onsuccess = () => { novos++; };
        // add() falha se a chave já existe: o erro é esperado e ignorado abaixo.
      }
      tx.oncomplete = () => { this.podar().catch(() => {}); resolve(novos); };
      tx.onerror = (e) => { e.preventDefault?.(); };
      tx.onabort = () => resolve(novos);
    });
  }

  async limpar() {
    const db = await this.abrir();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      tx.objectStore(this.storeName).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }
}