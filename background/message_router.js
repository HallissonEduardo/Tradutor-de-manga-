function registrarHandlersMensagens(rotas) {
  chrome.runtime.onMessage.addListener((msg, sender, enviarResposta) => {
    const rota = rotas[msg?.acao];
    if (!rota) return false;

    Promise.resolve()
      .then(() => rota(msg, sender))
      .then((resposta) => enviarResposta({ sucesso: true, ...resposta }))
      .catch((erro) => enviarResposta({
        sucesso: false,
        erro: erro?.message || String(erro)
      }));
    return true;
  });
}
