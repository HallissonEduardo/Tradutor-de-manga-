const CATALOGO_IDIOMAS = Object.freeze({
  en: Object.freeze({ nome: "Inglês", nomeTraducao: "inglês", ocr: "eng" }),
  ja: Object.freeze({ nome: "Japonês", nomeTraducao: "japonês", ocr: "jpn", ocrVertical: "jpn_vert" }),
  ko: Object.freeze({ nome: "Coreano", nomeTraducao: "coreano", ocr: "kor" }),
  zh: Object.freeze({ nome: "Chinês", nomeTraducao: "chinês", ocr: "chi_sim" }),
  es: Object.freeze({ nome: "Espanhol", nomeTraducao: "espanhol", ocr: "spa" }),
  "pt-BR": Object.freeze({ nome: "Português do Brasil", nomeTraducao: "português do Brasil" }),
  pt: Object.freeze({ nome: "Português", nomeTraducao: "português" }),
  fr: Object.freeze({ nome: "Francês", nomeTraducao: "francês" }),
  de: Object.freeze({ nome: "Alemão", nomeTraducao: "alemão" }),
  it: Object.freeze({ nome: "Italiano", nomeTraducao: "italiano" })
});

const IDIOMAS_ORIGEM = Object.freeze(["en", "ja", "ko", "zh", "es"]);
const IDIOMAS_DESTINO = Object.freeze(["pt-BR", "en", "es"]);

function nomeIdioma(codigo) {
  return CATALOGO_IDIOMAS[codigo]?.nomeTraducao || codigo;
}

function codigoOcr(codigo, vertical = false) {
  const idioma = CATALOGO_IDIOMAS[codigo];
  return vertical && codigo === "ja" ? idioma.ocrVertical : idioma?.ocr;
}
