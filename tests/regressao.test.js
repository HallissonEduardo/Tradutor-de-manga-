const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const raiz = path.resolve(__dirname, "..");

function carregarGlobal(caminho, exportar, chrome = {}) {
  const contexto = {
    chrome: {
      storage: {
        local: {
          get: async () => ({}),
          set: async () => {},
          remove: async () => {}
        },
        session: {
          get: async () => ({}),
          set: async () => {}
        }
      },
      ...chrome
    },
    console
  };
  vm.createContext(contexto);
  const fonte = fs.readFileSync(path.join(raiz, caminho), "utf8");
  vm.runInContext(`${fonte}\nglobalThis.__exportacaoTeste = ${exportar};`, contexto);
  return contexto.__exportacaoTeste;
}

test("divide falas em frases sem perder a pontuação", () => {
  const { dividirFrases, normalizarFrase } = carregarGlobal(
    "lib/frases.js",
    "{ dividirFrases, normalizarFrase }"
  );

  assert.deepEqual(Array.from(dividirFrases("I see. Wait!")), ["I see.", "Wait!"]);
  assert.equal(normalizarFrase("  I DON'T know! "), "idontknow");
});

test("dicionário embutido japonês preserva pontuação e limita o par de idiomas", async () => {
  const { DicionarioFalas } = carregarGlobal(
    "lib/dicionario.js",
    "{ DicionarioFalas }"
  );
  const dicionario = new DicionarioFalas();

  assert.equal(await dicionario.buscar("ja", "pt-BR", "「ありがとう！」"), "「Obrigado！」");
  assert.equal(await dicionario.buscar("ja", "en", "ありがとう"), null);
});

test("catálogo mantém idiomas da interface e códigos OCR alinhados", () => {
  const { CATALOGO_IDIOMAS, IDIOMAS_ORIGEM, IDIOMAS_DESTINO, codigoOcr } = carregarGlobal(
    "lib/idiomas.js",
    "{ CATALOGO_IDIOMAS, IDIOMAS_ORIGEM, IDIOMAS_DESTINO, codigoOcr }"
  );

  assert.deepEqual(Array.from(IDIOMAS_ORIGEM), ["en", "ja", "ko", "zh", "es"]);
  assert.deepEqual(Array.from(IDIOMAS_DESTINO), ["pt-BR", "en", "es"]);
  assert.equal(codigoOcr("ja", true), "jpn_vert");
  assert.equal(codigoOcr("ja"), "jpn");
  assert.equal(CATALOGO_IDIOMAS["pt-BR"].nome, "Português do Brasil");
});

test("fallback usa Gemini se DeepL falha por cota e preserva origem", async () => {
  const { ServicoTraducao } = carregarGlobal(
    "lib/tradutor.js",
    "{ ServicoTraducao }"
  );
  const servico = new ServicoTraducao();
  const tentativas = [];

  servico.estaBloqueado = async () => false;
  servico.chamarDeepl = async () => {
    tentativas.push("deepl");
    const erro = new Error("cota esgotada");
    erro.status = 456;
    throw erro;
  };
  servico.bloquear = async () => {};
  servico.traduzirComGemini = async () => {
    tentativas.push("gemini");
    return "Olá";
  };
  servico.registrarContexto = async () => {};

  const resultado = await servico.traduzirLote(["Hello"], {
    deeplKey: "chave-de-teste",
    apiKey: "chave-de-teste",
    usarMyMemory: true
  });

  assert.deepEqual(tentativas, ["deepl", "gemini"]);
  assert.equal(JSON.stringify(resultado), JSON.stringify({ textos: ["Olá"], origem: "gemini" }));
});

test("pipeline aceita provedores injetados sem alterar o contrato de saída", async () => {
  const { ServicoTraducao } = carregarGlobal(
    "lib/tradutor.js",
    "{ ServicoTraducao }"
  );
  const servico = new ServicoTraducao({
    provedores: [{
      id: "local-teste",
      habilitado: () => true,
      estaBloqueado: async () => false,
      emPausa: () => false,
      erroPausa: () => new Error("pausado"),
      traduzir: async (textos) => textos.map(() => "Resultado"),
      podeContinuar: () => true,
      registrarFalha: async () => {}
    }]
  });

  const resultado = await servico.traduzirLote(["Texto"], {});

  assert.equal(JSON.stringify(resultado), JSON.stringify({
    textos: ["Resultado"],
    origem: "local-teste"
  }));
});

test("roteador mantém mensagens desconhecidas e normaliza respostas síncronas e erros", async () => {
  let listener;
  const registrarHandlersMensagens = carregarGlobal(
    "background/message_router.js",
    "registrarHandlersMensagens",
    { runtime: { onMessage: { addListener: (handler) => { listener = handler; } } } }
  );
  registrarHandlersMensagens({
    sincronica: () => ({ valor: 42 }),
    falha: () => { throw new Error("falha simulada"); }
  });

  assert.equal(listener({ acao: "desconhecida" }, {}, () => {}), false);

  const obterResposta = (acao) => new Promise((resolve) => {
    const continuaAssincrono = listener({ acao }, {}, resolve);
    assert.equal(continuaAssincrono, true);
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(await obterResposta("sincronica"))),
    { sucesso: true, valor: 42 }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(await obterResposta("falha"))),
    { sucesso: false, erro: "falha simulada" }
  );
});
