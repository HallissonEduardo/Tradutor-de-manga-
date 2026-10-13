// Injetado sob demanda (chrome.scripting). Se já existir, apenas alterna o estado.
(() => {
  if (window.__tradutorMangaOverlay) {
    window.__tradutorMangaOverlay.alternarGeral();
    return;
  }

  const INTERVALO_PADRAO_MS = 3000; // verificação periódica do modo automático
  const ESPERA_GATILHO_MS = 400;    // após rolar/clicar/teclar, espera a página assentar
  const ESPERA_INSTAVEL_MS = 500;   // reconferência rápida enquanto a imagem ainda muda
  const ESPACO_MIN_MS = 650;        // o Chrome limita captureVisibleTab a 2 chamadas/s
  const PAUSA_ERRO_MS = 15000;      // espera após falha no modo automático
  const FONTE_MAX = 18;             // teto de fonte: texto maior que isso vira "bloco gigante" sobre a arte
  const FONTE_CONFORTAVEL = 10;     // abaixo disso, a caixa cresce um pouco antes de reduzir mais a fonte
  const MARGEM_PX = 4;              // folga ao redor do texto original, para cobri-lo

  const AVISOS = {
    unico: "Arraste para selecionar o balão. ESC para sair.",
    monitor: "Monitorando a janela inteira. ESC para sair."
  };

  class TradutorOverlay {
    constructor() {
      this.ativo = false;
      this.arrastando = false;
      this.inicioX = 0;
      this.inicioY = 0;
      this.retangulo = null;
      this.janelas = new Set();
      this.modo = "unico";
      this.monitor = null;

      // Camada de seleção: fixa na viewport, só visível quando ativa.
      const sel = this.criarHost(
        "tradutor-manga-selecao",
        "position:fixed;inset:0;z-index:2147483647;display:none;"
      );
      this.hostSelecao = sel.host;

      // Camada das traduções: ancorada na origem do documento (acompanha o scroll da página).
      const trad = this.criarHost(
        "tradutor-manga-traducoes",
        "position:absolute;top:0;left:0;width:0;height:0;overflow:visible;z-index:2147483646;"
      );
      this.hostTraducoes = trad.host;
      this.sombraTraducoes = trad.shadow;

      this.camada = document.createElement("div");
      this.camada.className = "camada-selecao";
      sel.shadow.appendChild(this.camada);

      this.aviso = document.createElement("div");
      this.aviso.className = "painel-aviso";
      this.camada.appendChild(this.aviso);

      this.painelModos = this.criarPainelModos();
      this.camada.appendChild(this.painelModos);

      this.caixa = document.createElement("div");
      this.caixa.className = "caixa-selecao escondido";
      this.camada.appendChild(this.caixa);

      this.definirModo("unico");
      chrome.storage.local.get("modoSelecao").then((r) => {
        if (r.modoSelecao === "monitor" || r.modoSelecao === "unico") this.definirModo(r.modoSelecao);
        // Modo automático salvo: não há seleção a fazer, começa direto na janela inteira.
        if (r.modoSelecao === "monitor" && !this.monitor) this.iniciarMonitorJanela();
      }).catch(() => {});

      this.vincularEventos();
      this.alternar(true);
    }

    criarHost(id, css) {
      const host = document.createElement("div");
      host.id = id;
      host.style.cssText = css;
      const shadow = host.attachShadow({ mode: "closed" });
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = chrome.runtime.getURL("content/estilos.css");
      shadow.appendChild(link);
      document.documentElement.appendChild(host);
      return { host, shadow };
    }

    criarPainelModos() {
      const painel = document.createElement("div");
      painel.className = "painel-modos";
      [["unico", "Tradução única"], ["monitor", "Monitorar janela (automático)"]].forEach(([modo, rotulo]) => {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.modo = modo;
        b.textContent = rotulo;
        b.addEventListener("click", () => {
          this.definirModo(modo, true);
          if (modo === "monitor") this.iniciarMonitorJanela(); // sem seleção: usa a janela inteira
        });
        painel.appendChild(b);
      });
      // Cliques no painel não devem iniciar uma seleção.
      ["mousedown", "mousemove", "mouseup"].forEach((ev) =>
        painel.addEventListener(ev, (e) => e.stopPropagation())
      );
      return painel;
    }

    definirModo(modo, salvar = false) {
      this.modo = modo;
      this.aviso.textContent = AVISOS[modo];
      this.painelModos.querySelectorAll("button").forEach((b) =>
        b.classList.toggle("ativo", b.dataset.modo === modo)
      );
      if (salvar) chrome.storage.local.set({ modoSelecao: modo }).catch(() => {});
    }

    vincularEventos() {
      this.camada.addEventListener("mousedown", (e) => this.iniciarSelecao(e));
      this.camada.addEventListener("mousemove", (e) => this.arrastarSelecao(e));
      this.camada.addEventListener("mouseup", (e) => this.finalizarSelecao(e));
      // capture: true, pois páginas podem interceptar o ESC.
      window.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        if (this.monitor) { this.pararMonitor(); e.stopPropagation(); }
        if (this.ativo) { this.alternar(false); e.stopPropagation(); }
        this.fecharJanelas();
      }, true);
    }

    /** Área monitorada no modo automático: toda a janela visível do navegador (viewport). */
    coordsJanela() {
      return { x: 0, y: 0, largura: window.innerWidth, altura: window.innerHeight };
    }

    iniciarMonitorJanela() {
      this.alternar(false);
      this.iniciarMonitor(this.coordsJanela());
    }

    /**
     * Ícone/atalho: durante o monitoramento, encerra-o; no modo automático, inicia-o na janela
     * inteira; no modo único, alterna a camada de seleção.
     */
    alternarGeral() {
      if (this.monitor) { this.pararMonitor(); return; }
      if (this.ativo) { this.alternar(false); return; }
      if (this.modo === "monitor") this.iniciarMonitorJanela();
      else this.alternar(true);
    }

    alternar(estado) {
      this.ativo = estado ?? !this.ativo;
      this.hostSelecao.style.display = this.ativo ? "block" : "none";
      if (!this.ativo) {
        this.arrastando = false;
        this.caixa.classList.add("escondido");
      }
    }

    iniciarSelecao(e) {
      if (!this.ativo || e.button !== 0) return;
      e.preventDefault();
      this.arrastando = true;
      this.inicioX = e.clientX;
      this.inicioY = e.clientY;
      this.retangulo = { x: e.clientX, y: e.clientY, largura: 0, altura: 0 };
      this.desenharCaixa();
      this.caixa.classList.remove("escondido");
    }

    arrastarSelecao(e) {
      if (!this.arrastando) return;
      this.retangulo = {
        x: Math.min(this.inicioX, e.clientX),
        y: Math.min(this.inicioY, e.clientY),
        largura: Math.abs(e.clientX - this.inicioX),
        altura: Math.abs(e.clientY - this.inicioY)
      };
      this.desenharCaixa();
    }

    desenharCaixa() {
      const r = this.retangulo;
      Object.assign(this.caixa.style, {
        left: `${r.x}px`, top: `${r.y}px`, width: `${r.largura}px`, height: `${r.altura}px`
      });
    }

    async finalizarSelecao() {
      if (!this.arrastando) return;
      this.arrastando = false;
      this.caixa.classList.add("escondido");

      const coords = this.retangulo;
      if (!coords || coords.largura <= 10 || coords.altura <= 10) return; // clique acidental: segue ativo

      // Modo automático não usa seleção manual: monitora a janela inteira.
      if (this.modo === "monitor") {
        this.iniciarMonitorJanela();
        return;
      }

      const cursorAnterior = document.documentElement.style.cursor;
      try {
        // 1) Esconde seleção e traduções para não entrarem na captura.
        this.hostSelecao.style.display = "none";
        this.hostTraducoes.style.visibility = "hidden";
        await this.aguardarRepintura();

        const captura = await this.enviar({
          acao: "capturar_area",
          coords,
          viewportWidth: window.innerWidth
        });

        // 2) Restaura a interface (modo contínuo: o overlay segue ativo até o ESC).
        this.hostTraducoes.style.visibility = "visible";
        if (this.ativo) this.hostSelecao.style.display = "block";

        // 3) OCR + tradução. Nada é desenhado sobre a imagem enquanto espera: o único
        //    feedback é o cursor de "progresso".
        document.documentElement.style.cursor = "progress";
        const resultado = await this.enviar({ acao: "processar_captura", capturaId: captura.capturaId });
        this.renderizarItens(coords, resultado.itens, null);
      } catch (erro) {
        this.hostTraducoes.style.visibility = "visible";
        if (this.ativo) this.hostSelecao.style.display = "block";
        const janela = this.criarJanela(coords, "", "erro");
        this.atualizarJanela(janela, coords, this.mensagemErro(erro), "erro");
        console.error("Erro no fluxo de tradução:", erro);
      } finally {
        document.documentElement.style.cursor = cursorAnterior;
      }
    }

    // ---------------- Modo automático ----------------

    async iniciarMonitor(coords) {
      this.pararMonitor();
      let intervalo = INTERVALO_PADRAO_MS;
      try {
        const r = await chrome.storage.local.get("intervaloMonitor");
        if (Number(r.intervaloMonitor) >= 1) intervalo = Number(r.intervaloMonitor) * 1000;
      } catch { /* usa o padrão */ }

      const m = {
        coords, intervalo,
        timer: null, ocupado: false, reagendar: false,
        forcar: true,          // primeira verificação: traduz a página atual
        seq: 0,                // descarta traduções de páginas que já ficaram para trás
        elementos: [], badge: null,
        proximo: intervalo, ultimaVerif: 0, ultimoErro: "",
        ouvintes: [], observador: null
      };
      this.monitor = m;
      this.criarBadge(m);
      this.ligarGatilhos(m);
      this.agendar(m, 0);
    }

    pararMonitor() {
      const m = this.monitor;
      if (!m) return;
      this.monitor = null;
      clearTimeout(m.timer);
      m.ouvintes.forEach((desligar) => desligar());
      m.observador?.disconnect();
      m.badge?.remove();
      this.limparElementos(m);
      this.hostTraducoes.style.visibility = "visible";
      try { chrome.runtime.sendMessage({ acao: "monitor_parar" }).catch(() => {}); } catch { /* contexto inválido */ }
    }

    criarBadge(m) {
      const b = document.createElement("div");
      b.className = "controle-monitor";

      const ponto = document.createElement("span");
      ponto.className = "ponto";
      const texto = document.createElement("span");
      texto.className = "rotulo";
      texto.textContent = "Monitorando";
      const retraduzir = document.createElement("button");
      retraduzir.textContent = "Retraduzir";
      retraduzir.addEventListener("click", () => { m.forcar = true; this.agendar(m, 0); });
      const manual = document.createElement("button");
      manual.textContent = "Seleção manual";
      manual.addEventListener("click", () => {
        this.pararMonitor();
        this.definirModo("unico", true);
        this.alternar(true);
      });
      const parar = document.createElement("button");
      parar.textContent = "Parar";
      parar.addEventListener("click", () => this.pararMonitor());
      b.append(ponto, texto, retraduzir, manual, parar);

      // Escolhe um canto da tela que não cubra a área monitorada.
      const L = 250, A = 36, M = 12;
      const cantos = [
        { right: M, bottom: M, x: innerWidth - L - M, y: innerHeight - A - M },
        { left: M, bottom: M, x: M, y: innerHeight - A - M },
        { right: M, top: M, x: innerWidth - L - M, y: M },
        { left: M, top: M, x: M, y: M }
      ];
      const c = m.coords;
      const livre = cantos.find((k) => k.x + L < c.x || k.x > c.x + c.largura || k.y + A < c.y || k.y > c.y + c.altura) || cantos[0];
      ["left", "right", "top", "bottom"].forEach((lado) => { if (livre[lado] != null) b.style[lado] = `${livre[lado]}px`; });

      this.sombraTraducoes.appendChild(b);
      m.badge = b;
      m.badgeTexto = texto;
    }

    /**
     * Status do monitor SEM desenhar nada sobre a imagem: tudo vai para o indicador do canto.
     * estado: "ok" | "traduzindo" | "erro" (com mensagem).
     */
    estadoBadge(m, estado, mensagem = "") {
      if (!m.badge) return;
      m.badge.classList.toggle("traduzindo", estado === "traduzindo");
      m.badge.classList.toggle("com-erro", estado === "erro");
      m.badgeTexto.textContent =
        estado === "traduzindo" ? "Traduzindo…" : estado === "erro" ? mensagem : "Monitorando";
      m.badgeTexto.title = estado === "erro" ? mensagem : "";
    }

    ligarGatilhos(m) {
      const gatilho = (esconder) => (e) => {
        if (this.monitor !== m) return;
        if (e?.type === "keydown" && e.key === "Escape") return;
        if (e?.target === this.hostTraducoes) return; // cliques na nossa própria interface
        if (esconder) this.ocultarBalao(m);
        this.agendar(m, ESPERA_GATILHO_MS);
      };
      const registrar = (alvo, tipo, fn, opcoes) => {
        alvo.addEventListener(tipo, fn, opcoes);
        m.ouvintes.push(() => alvo.removeEventListener(tipo, fn, opcoes));
      };

      registrar(window, "scroll", gatilho(true), { capture: true, passive: true });
      registrar(window, "wheel", gatilho(true), { capture: true, passive: true });
      registrar(window, "touchend", gatilho(true), { capture: true, passive: true });
      registrar(window, "keydown", gatilho(true), true);
      registrar(window, "click", gatilho(true), true);
      registrar(window, "popstate", gatilho(true));
      registrar(window, "hashchange", gatilho(true));
      // A área é a janela inteira: se ela mudar de tamanho, recalcula e retraduz.
      registrar(window, "resize", () => {
        if (this.monitor !== m) return;
        m.coords = this.coordsJanela();
        m.forcar = true;
        this.limparElementos(m);
        this.agendar(m, 800);
      });

      // Leitores que trocam a imagem via JS (sem scroll/clique detectável).
      const observador = new MutationObserver((muts) => {
        const relevante = muts.some((mu) =>
          mu.type === "attributes" ||
          [...mu.addedNodes].some((n) =>
            n.nodeType === 1 && (/^(IMG|CANVAS|PICTURE|SVG)$/i.test(n.tagName) || n.querySelector?.("img,canvas"))
          )
        );
        if (relevante) this.agendar(m, ESPERA_GATILHO_MS);
      });
      observador.observe(document.body || document.documentElement, {
        subtree: true, childList: true, attributes: true, attributeFilter: ["src", "srcset", "data-src"]
      });
      m.observador = observador;
    }

    agendar(m, ms) {
      if (this.monitor !== m) return;
      if (m.ocupado) { m.reagendar = true; return; }
      clearTimeout(m.timer);
      const espera = Math.max(ms, ESPACO_MIN_MS - (Date.now() - m.ultimaVerif));
      m.timer = setTimeout(() => this.verificarMonitor(m), Math.max(0, espera));
    }

    ocultarBalao(m) { m.elementos.forEach((e) => { e.style.visibility = "hidden"; }); }
    mostrarBalao(m) { m.elementos.forEach((e) => { e.style.visibility = ""; }); }

    limparElementos(m) {
      m.elementos.forEach((e) => { e.remove(); this.janelas.delete(e); });
      m.elementos = [];
    }

    async verificarMonitor(m) {
      if (this.monitor !== m || m.ocupado) return;
      m.ocupado = true;
      m.reagendar = false;
      m.ultimaVerif = Date.now();

      try {
        // Esconde nossa interface só durante a captura.
        this.hostTraducoes.style.visibility = "hidden";
        let r;
        try {
          await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
          r = await this.enviar({
            acao: "monitor_verificar",
            coords: m.coords,
            viewportWidth: window.innerWidth,
            forcar: m.forcar
          }, 15000);
        } finally {
          this.hostTraducoes.style.visibility = "visible";
        }
        m.forcar = false;
        m.ultimoErro = "";
        if (this.monitor !== m) return;

        if (r.estado === "igual") {
          this.mostrarBalao(m);
          if (m.erroVerif) { m.erroVerif = false; this.estadoBadge(m, "ok"); }
          m.proximo = m.intervalo;
        } else if (r.estado === "limitado") {
          this.ocultarBalao(m); // trava de segurança: muitas traduções novas no último minuto
          m.proximo = 5000;
        } else if (r.estado === "instavel") {
          this.ocultarBalao(m); // a página mudou: o balão antigo não vale mais
          m.proximo = ESPERA_INSTAVEL_MS;
        } else if (r.estado === "novo") {
          this.limparElementos(m);
          this.estadoBadge(m, "traduzindo"); // sem quadrado sobre a imagem
          m.proximo = m.intervalo;
          this.traduzirMonitor(m, r.capturaId, ++m.seq); // sem await: não trava novas verificações
        }
      } catch (erro) {
        if (/context invalidated/i.test(erro.message)) { this.pararMonitor(); return; }
        console.error("Monitor:", erro);
        m.proximo = Math.max(PAUSA_ERRO_MS, m.intervalo);
        if (this.monitor === m && erro.message !== m.ultimoErro) {
          m.ultimoErro = erro.message;
          m.erroVerif = true;
          this.limparElementos(m);
          this.estadoBadge(m, "erro", this.mensagemErro(erro)); // erro no indicador, não sobre a imagem
        }
      } finally {
        m.ocupado = false;
        if (this.monitor === m) this.agendar(m, m.reagendar ? ESPERA_GATILHO_MS : m.proximo);
      }
    }

    async traduzirMonitor(m, capturaId, seq) {
      try {
        const res = await this.enviar({ acao: "processar_captura", capturaId });
        if (this.monitor !== m || m.seq !== seq) return; // já trocou de página
        this.limparElementos(m);
        m.elementos = this.renderizarItens(m.coords, res.itens, m);
        this.estadoBadge(m, "ok");
      } catch (erro) {
        if (this.monitor !== m || m.seq !== seq) return;
        this.limparElementos(m);
        this.estadoBadge(m, "erro", this.mensagemErro(erro)); // "Retraduzir" no indicador tenta de novo
      }
    }

    // ---------------- Utilitários ----------------

    mensagemErro(erro) {
      return /context invalidated/i.test(erro.message)
        ? "Extensão atualizada. Recarregue a página."
        : erro.message;
    }

    enviar(mensagem, timeoutMs = 120000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Tempo esgotado aguardando a extensão.")), timeoutMs);
        try {
          chrome.runtime.sendMessage(mensagem, (res) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (!res) return reject(new Error("Sem resposta da extensão."));
            if (!res.sucesso) return reject(new Error(res.erro || "Erro desconhecido."));
            resolve(res);
          });
        } catch (e) {
          clearTimeout(timer);
          reject(e);
        }
      });
    }

    aguardarRepintura() {
      return new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))
      );
    }

    /** `monitor` (opcional): balão do modo automático, fixo na viewport e com cliques próprios. */
    criarJanela(coords, texto, classe, monitor = null) {
      const janela = document.createElement("div");
      janela.className = `janela-traducao ${classe || ""}`.trim();
      if (monitor) {
        janela.style.position = "fixed";
        janela.style.left = `${coords.x}px`;
        janela.style.top = `${coords.y}px`;
      } else {
        janela.style.left = `${coords.x + window.scrollX}px`;
        janela.style.top = `${coords.y + window.scrollY}px`;
      }
      janela.style.width = `${Math.max(coords.largura, 120)}px`;
      janela.style.minHeight = `${coords.altura}px`;
      janela.textContent = texto;

      janela.addEventListener("click", () => {
        if (!monitor) { janela.remove(); this.janelas.delete(janela); return; }
        if (janela.classList.contains("erro")) {   // erro: clique tenta de novo
          this.limparElementos(monitor);
          monitor.forcar = true;
          this.agendar(monitor, 0);
        } else {                                    // clique alterna para ver o original
          const alvo = !janela.classList.contains("transparente");
          monitor.elementos.forEach((e) => e.classList.toggle("transparente", alvo));
        }
      });

      this.sombraTraducoes.appendChild(janela);
      this.janelas.add(janela);
      return janela;
    }

    /**
     * Cria um balão de tradução por item, posicionado sobre o texto original.
     * itens[].caixa está em frações da área selecionada (`coords`) e delimita o TEXTO original
     * (caixa justa): o balão de tradução o cobre com uma folga fixa de poucos pixels, como na
     * versão desktop, em vez de pintar uma área grande sobre a arte.
     * Adaptações: cores do fundo original, fonte limitada (FONTE_MAX) e ajustada ao espaço útil.
     */
    renderizarItens(coords, itens, monitor) {
      const elementos = [];
      for (const it of itens) {
        const sfx = it.tipo === "sfx";
        const folga = sfx ? 0 : MARGEM_PX;

        const L0 = coords.largura * it.caixa.w + 2 * folga;
        const A0 = coords.altura * it.caixa.h + 2 * folga;
        const X0 = coords.x + coords.largura * it.caixa.x - folga;
        const Y0 = coords.y + coords.altura * it.caixa.y - folga;
        const dx = monitor ? 0 : window.scrollX, dy = monitor ? 0 : window.scrollY;

        const el = document.createElement("div");
        el.className = `janela-traducao item tipo-${it.tipo}`;
        el.style.position = monitor ? "fixed" : "absolute";
        el.style.background = it.fundo || "#fff";
        el.style.color = it.cor || "#111";
        el.style.borderRadius = "8px";

        const texto = document.createElement("div");
        texto.className = "texto";
        texto.textContent = it.texto;
        el.appendChild(texto);

        el.addEventListener("click", () => {
          if (!monitor) { el.remove(); this.janelas.delete(el); return; }
          const alvo = !el.classList.contains("transparente");
          monitor.elementos.forEach((e) => e.classList.toggle("transparente", alvo));
        });

        this.sombraTraducoes.appendChild(el);
        this.janelas.add(el);

        // Se o texto traduzido não cabe com fonte confortável, a caixa cresce (centrada, até 60%)
        // em vez de a fonte ficar ilegível. Sem isso a tradução mais longa que o original vira
        // letra minúscula.
        const fator = sfx ? 1 : 0.92;
        let esc = 1, tamanho;
        for (;;) {
          const L = Math.max(8, L0 * esc), A = Math.max(8, A0 * esc);
          el.style.left = `${X0 - (L - L0) / 2 + dx}px`;
          el.style.top = `${Y0 - (A - A0) / 2 + dy}px`;
          el.style.width = `${L}px`;
          el.style.height = `${A}px`;
          tamanho = this.ajustarFonte(texto, L * fator, A * fator);
          if (tamanho >= FONTE_CONFORTAVEL || esc >= 1.6) break;
          esc *= 1.15;
        }
        elementos.push(el);
      }
      return elementos;
    }

    /** Busca binária pelo maior tamanho de fonte (até FONTE_MAX) em que o texto cabe. Devolve o tamanho. */
    ajustarFonte(t, largura, altura) {
      t.style.width = `${largura}px`;
      t.style.overflowWrap = "normal";
      const cabe = () => t.offsetHeight <= altura + 1 && t.scrollWidth <= largura + 1;
      const buscar = () => {
        let lo = 7, hi = Math.max(7, Math.min(FONTE_MAX, Math.floor(altura)));
        let melhor = 0;
        while (lo <= hi) {
          const meio = (lo + hi) >> 1;
          t.style.fontSize = `${meio}px`;
          if (cabe()) { melhor = meio; lo = meio + 1; } else hi = meio - 1;
        }
        return melhor;
      };
      let tamanho = buscar();
      if (!tamanho) { // palavra maior que a largura: permite quebrar no meio
        t.style.overflowWrap = "anywhere";
        tamanho = buscar() || 7;
      }
      t.style.fontSize = `${tamanho}px`;
      return tamanho;
    }

    atualizarJanela(janela, coords, texto, classe = "") {
      janela.className = `janela-traducao ${classe}`.trim();
      janela.textContent = texto;
      if (classe) return;
      // Auto-ajuste da fonte para caber na altura do balão.
      let tamanho = 18;
      janela.style.fontSize = `${tamanho}px`;
      while (tamanho > 9 && janela.offsetHeight > coords.altura + 2) {
        tamanho -= 1;
        janela.style.fontSize = `${tamanho}px`;
      }
    }

    fecharJanelas() {
      this.janelas.forEach((j) => j.remove());
      this.janelas.clear();
    }
  }

  window.__tradutorMangaOverlay = new TradutorOverlay();
})();
