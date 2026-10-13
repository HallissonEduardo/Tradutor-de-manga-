const $ = (id) => document.getElementById(id);

function mostrar(msg, ok = true, ms = 4000) {
  const s = $("status");
  s.textContent = msg;
  s.className = "status " + (ok ? "ok" : "erro");
  if (ms) setTimeout(() => { s.textContent = ""; }, ms);
}

document.addEventListener("DOMContentLoaded", async () => {
  const res = await chrome.storage.local.get([
    "geminiApiKey", "geminiModelo", "idiomaOrigem", "idiomaDestino",
    "myMemoryEmail", "modoTraducao", "japonesVertical", "intervaloMonitor", "deeplApiKey"
  ]);
  $("apiKey").value = res.geminiApiKey || "";
  $("deeplKey").value = res.deeplApiKey || "";
  const atualizarPlanoDeepl = () => {
    const k = $("deeplKey").value.trim();
    $("deeplPlano").textContent = !k
      ? "Chaves do plano Free terminam em :fx. Salva apenas neste navegador."
      : /:fx$/i.test(k) ? "Plano detectado: Free (api-free.deepl.com)." : "Plano detectado: Pro (api.deepl.com).";
  };
  $("deeplKey").addEventListener("input", atualizarPlanoDeepl);
  atualizarPlanoDeepl();
  // ---------- Status dos provedores (bloqueios persistentes do service worker) ----------
  const quando = (ate) => {
    const d = new Date(ate);
    const hoje = d.toDateString() === new Date().toDateString();
    return d.toLocaleString("pt-BR", hoje
      ? { hour: "2-digit", minute: "2-digit" }
      : { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  };
  const liberarDeepl = () => chrome.storage.local.remove(["deeplBloqueioAte", "deeplBloqueioMotivo"]);
  const atualizarStatusProvedores = async () => {
    const b = await chrome.storage.local.get(["geminiBloqueioAte", "deeplBloqueioAte", "deeplBloqueioMotivo"]);
    const agora = Date.now();
    const linhas = [];
    if (Number(b.deeplBloqueioAte) > agora) {
      linhas.push(`DeepL desativado até ${quando(b.deeplBloqueioAte)}${b.deeplBloqueioMotivo ? ` (${b.deeplBloqueioMotivo})` : ""}. Ajuste a chave ou a cota; salvar uma chave nova ou testá-la com sucesso o reativa.`);
    }
    if (Number(b.geminiBloqueioAte) > agora) {
      linhas.push(`Gemini em pausa até ${quando(b.geminiBloqueioAte)} (limite de uso, erro 429).`);
    }
    $("statusProvedores").textContent = linhas.join(" ");
    $("reativarDeepl").hidden = !(Number(b.deeplBloqueioAte) > agora);
  };
  atualizarStatusProvedores();
  $("reativarDeepl").addEventListener("click", async () => {
    await liberarDeepl();
    await atualizarStatusProvedores();
    mostrar("DeepL reativado.");
  });

  $("modelo").value = res.geminiModelo || "gemini-2.5-flash";
  $("origem").value = res.idiomaOrigem || "en";
  $("destino").value = res.idiomaDestino || "pt-BR";
  $("email").value = res.myMemoryEmail || "";
  const MODOS = ["hibrido", "gemini", "mymemory"];
  $("modo").value = MODOS.includes(res.modoTraducao) ? res.modoTraducao : "hibrido";
  $("vertical").checked = res.japonesVertical !== false;
  $("intervalo").value = res.intervaloMonitor || 3;

  $("salvar").addEventListener("click", async () => {
    const modelo = $("modelo").value.trim();
    if (!modelo) return mostrar("Informe o modelo do Gemini.", false);
    const chaveDeepl = $("deeplKey").value.trim();
    if (chaveDeepl) await chrome.storage.local.set({ deeplApiKey: chaveDeepl });
    else await chrome.storage.local.remove("deeplApiKey");
    // Chave nova (ou removida): o ajuste que o bloqueio de 1 dia esperava foi feito.
    if (chaveDeepl !== (res.deeplApiKey || "")) { await liberarDeepl(); res.deeplApiKey = chaveDeepl; }
    await chrome.storage.local.set({
      geminiApiKey: $("apiKey").value.trim(),
      geminiModelo: modelo,
      idiomaOrigem: $("origem").value,
      idiomaDestino: $("destino").value,
      myMemoryEmail: $("email").value.trim(),
      modoTraducao: $("modo").value,
      japonesVertical: $("vertical").checked,
      intervaloMonitor: Math.min(30, Math.max(1, Number($("intervalo").value) || 3))
    });
    await atualizarStatusProvedores();
    mostrar("Configurações salvas com sucesso!");
  });

  $("testar").addEventListener("click", async () => {
    const apiKey = $("apiKey").value.trim();
    if (!apiKey) return mostrar("Cole a chave antes de testar.", false);
    mostrar("Testando…", true, 0);
    try {
      const r = await chrome.runtime.sendMessage({
        acao: "testar_chave", apiKey, modelo: $("modelo").value.trim()
      });
      if (r?.sucesso) { await atualizarStatusProvedores(); mostrar("Chave válida!"); }
      else mostrar(r?.erro || "Falha ao testar a chave.", false, 8000);
    } catch (e) {
      mostrar(e.message, false, 8000);
    }
  });

  $("testarDeepl").addEventListener("click", async () => {
    const chave = $("deeplKey").value.trim();
    if (!chave) return mostrar("Cole a chave do DeepL antes de testar.", false);
    mostrar("Testando…", true, 0);
    try {
      const r = await chrome.runtime.sendMessage({ acao: "testar_deepl", chave });
      if (r?.sucesso) {
        await liberarDeepl(); // chave funcionando: encerra o bloqueio de 1 dia
        await atualizarStatusProvedores();
        mostrar(`Chave do DeepL válida (plano ${r.plano}; ${r.usados ?? "?"}/${r.limite ?? "?"} caracteres usados).`);
      }
      else mostrar(r?.erro || "Falha ao testar a chave do DeepL.", false, 8000);
    } catch (e) {
      mostrar(e.message, false, 8000);
    }
  });

  $("removerDeepl").addEventListener("click", async () => {
    if (!$("deeplKey").value.trim() && !res.deeplApiKey) return mostrar("Nenhuma chave do DeepL salva.", false);
    await chrome.storage.local.remove("deeplApiKey");
    await liberarDeepl();
    res.deeplApiKey = "";
    $("deeplKey").value = "";
    atualizarPlanoDeepl();
    await atualizarStatusProvedores();
    mostrar("Chave do DeepL removida.");
  });

  // ---------- Cache ----------
  const msgCache = async (acao, extra = {}) => {
    const r = await chrome.runtime.sendMessage({ acao, ...extra });
    if (!r?.sucesso) throw new Error(r?.erro || "Falha na operação do cache.");
    return r;
  };

  $("cacheExportar").addEventListener("click", async () => {
    try {
      const { itens } = await msgCache("cache_exportar");
      if (!itens.length) return mostrar("O cache por texto está vazio.", false);
      const url = URL.createObjectURL(new Blob([JSON.stringify(itens)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "cache_traducao.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      mostrar(`${itens.length} traduções exportadas.`);
    } catch (e) { mostrar(e.message, false, 8000); }
  });

  $("cacheImportar").addEventListener("click", () => $("arquivoCache").click());
  $("arquivoCache").addEventListener("change", async (ev) => {
    const arquivo = ev.target.files[0];
    ev.target.value = "";
    if (!arquivo) return;
    try {
      const itens = JSON.parse(await arquivo.text());
      if (!Array.isArray(itens)) throw new Error("Arquivo inválido: esperava uma lista [{k, v}].");
      const { novos } = await msgCache("cache_importar", { itens });
      mostrar(`${novos} traduções novas importadas.`);
    } catch (e) { mostrar(e.message, false, 8000); }
  });

  $("cacheLimpar").addEventListener("click", async () => {
    if (!confirm("Apagar todo o cache de traduções?")) return;
    try { await msgCache("cache_limpar"); mostrar("Cache limpo."); }
    catch (e) { mostrar(e.message, false, 8000); }
  });

  // ---------- Dicionário de falas frequentes ----------
  const atualizarDicionario = async () => {
    try {
      const r = await msgCache("dicionario_info");
      $("infoDicionario").textContent = `${r.embutidas} falas embutidas · ${r.aprendidas} aprendidas com o uso.`;
    } catch { $("infoDicionario").textContent = ""; }
  };
  atualizarDicionario();

  $("dicionarioLimpar").addEventListener("click", async () => {
    if (!confirm("Apagar as falas aprendidas com o uso? A lista embutida não é afetada.")) return;
    try { await msgCache("dicionario_limpar"); await atualizarDicionario(); mostrar("Falas aprendidas apagadas."); }
    catch (e) { mostrar(e.message, false, 8000); }
  });
});
