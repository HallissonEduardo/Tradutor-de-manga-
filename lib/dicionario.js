// Dicionário de falas frequentes. Roda no service worker.
//
// Duas camadas, consultadas ANTES do cache e das APIs (fala resolvida aqui não gasta requisição):
//  1. Embutida (DICIONARIO_INICIAL): lista curada, fixa, por par de idiomas ("origem>destino").
//     É indexada pelo "miolo" da fala, sem a pontuação das pontas: "hey", "Hey.", "HEY!!" e "...hey?"
//     batem na mesma entrada, e a pontuação do original é reaplicada na tradução ("Hey!!" -> "Ei!!").
//  2. Aprendida: falas curtas traduzidas de verdade pelo DeepL ou pelo Gemini passam a ser guardadas
//     (storage.local, com contador de uso) e reutilizadas em qualquer provedor. Chave exata, com a
//     pontuação, para não aplicar uma tradução sem o "¿ ¡" do espanhol etc.
const CHAVE_APRENDIDAS = "falasAprendidas";
const MAX_APRENDIDAS = 2000;     // acima disso, saem as menos usadas (e mais antigas)
const MAX_TRADUCAO_APRENDIDA = 80;

const PREFIXO_FALA = /^[\s"'¿¡.…~-]*/;
const SUFIXO_FALA = /[\s"')\].!?…,;:~-]*$/;
const tem = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

// en -> pt-BR. Chaves em minúsculas, sem pontuação nas pontas; valores já capitalizados.
const DICIONARIO_INICIAL = {
  "en>pt-BR": {
    // Cumprimentos e despedidas
    "hey": "Ei", "hey you": "Ei, você", "hello": "Olá", "hi": "Oi", "yo": "E aí", "what's up": "E aí",
    "good morning": "Bom dia", "good afternoon": "Boa tarde", "good evening": "Boa noite", "good night": "Boa noite",
    "goodbye": "Adeus", "bye": "Tchau", "bye-bye": "Tchau, tchau", "see you": "Até mais",
    "see you later": "Até mais tarde", "see you tomorrow": "Até amanhã", "welcome": "Bem-vindo",
    "welcome back": "Bem-vindo de volta", "welcome home": "Bem-vindo de volta", "i'm home": "Cheguei",
    "i'm back": "Voltei", "long time no see": "Quanto tempo", "it's been a while": "Faz tempo",
    "nice to meet you": "Prazer em conhecê-lo", "excuse me": "Com licença",
    // Sim, não e afins
    "yes": "Sim", "no": "Não", "yeah": "É", "yep": "Sim", "nope": "Não", "okay": "Ok", "ok": "Ok",
    "all right": "Tudo bem", "alright": "Tudo bem", "sure": "Claro", "of course": "Claro",
    "certainly": "Com certeza", "maybe": "Talvez", "perhaps": "Talvez", "probably": "Provavelmente",
    "i guess": "Acho que sim", "i think so": "Acho que sim", "i don't think so": "Acho que não",
    "not yet": "Ainda não", "not really": "Na verdade, não", "no way": "Não pode ser",
    "no problem": "Sem problema", "no thanks": "Não, obrigado", "that's right": "Isso mesmo",
    "exactly": "Exatamente", "correct": "Correto", "wrong": "Errado", "that's wrong": "Está errado",
    "that's it": "É isso", "that's all": "Isso é tudo", "that's enough": "Chega", "enough": "Chega",
    "is that so": "É mesmo", "is that right": "É mesmo", "really": "Sério", "seriously": "Sério",
    "me too": "Eu também", "you too": "Você também", "it's me": "Sou eu", "it's you": "É você",
    // Entender, saber
    "i see": "Entendo", "oh i see": "Ah, entendi", "i understand": "Entendi", "understood": "Entendido",
    "got it": "Entendi", "i got it": "Entendi", "i know": "Eu sei", "i don't know": "Não sei",
    "i don't understand": "Não entendo", "never mind": "Deixa pra lá", "forget it": "Esqueça",
    "i don't care": "Não me importo",
    // Perguntas
    "what": "O quê", "what's wrong": "O que houve", "what's that": "O que é isso", "what is it": "O que foi",
    "what happened": "O que aconteceu", "what are you doing": "O que você está fazendo",
    "what do you mean": "O que você quer dizer", "what is this": "O que é isso", "what is that": "O que é aquilo",
    "who": "Quem", "who are you": "Quem é você", "who is it": "Quem é", "who's there": "Quem está aí",
    "where": "Onde", "where are you": "Onde você está", "when": "Quando", "why": "Por quê", "why not": "Por que não",
    "how": "Como", "how come": "Como assim", "which": "Qual", "which one": "Qual",
    // Agradecer, desculpar
    "thank you": "Obrigado", "thanks": "Obrigado", "thank you very much": "Muito obrigado",
    "you're welcome": "De nada", "don't mention it": "Não precisa agradecer", "please": "Por favor",
    "sorry": "Desculpe", "i'm sorry": "Desculpe", "my bad": "Foi mal",
    // Ordens e avisos
    "wait": "Espere", "wait a minute": "Espere um pouco", "hold on": "Espere", "just a moment": "Só um momento",
    "hurry": "Rápido", "hurry up": "Anda logo", "come on": "Vamos lá", "let's go": "Vamos", "let's do it": "Vamos nessa",
    "go": "Vá", "stop": "Pare", "stop it": "Pare com isso", "don't": "Não", "don't do it": "Não faça isso",
    "don't move": "Não se mexa", "don't go": "Não vá", "don't worry": "Não se preocupe", "look": "Olhe",
    "look out": "Cuidado", "watch out": "Cuidado", "careful": "Cuidado", "be careful": "Tenha cuidado",
    "run": "Corra", "run away": "Fuja", "get down": "Abaixe-se", "quiet": "Silêncio", "be quiet": "Fique quieto",
    "shut up": "Cala a boca", "silence": "Silêncio", "listen": "Ouça", "listen to me": "Me escute",
    "look at me": "Olhe para mim", "answer me": "Me responda", "tell me": "Me diga", "come here": "Venha aqui",
    "come in": "Entre", "let me go": "Me solte", "let go": "Solte", "help": "Socorro", "help me": "Me ajude",
    "leave it to me": "Deixa comigo", "let me see": "Deixe-me ver", "do your best": "Dê o seu melhor",
    "you can do it": "Você consegue", "good luck": "Boa sorte", "cheers": "Saúde",
    // Lugar e tempo
    "here": "Aqui", "there": "Lá", "over here": "Aqui", "over there": "Lá", "this way": "Por aqui",
    "right here": "Aqui mesmo", "now": "Agora", "later": "Depois", "again": "De novo",
    "once more": "Mais uma vez", "one more time": "Mais uma vez",
    // Eu, você
    "i can't": "Eu não consigo", "i can": "Eu consigo", "i can do it": "Eu consigo", "i will": "Eu vou",
    "i won't": "Eu não vou", "i'll do it": "Eu vou fazer", "i'll help you": "Eu vou te ajudar",
    "i'm fine": "Estou bem", "i'm okay": "Estou bem", "are you okay": "Você está bem",
    "are you all right": "Você está bem", "it's okay": "Tudo bem", "it's fine": "Tudo bem",
    "i'm serious": "Estou falando sério", "i'm not kidding": "Não estou brincando",
    "are you serious": "Você está falando sério", "you're kidding": "Está brincando", "you're joking": "Está brincando",
    "i'm scared": "Estou com medo", "i'm hungry": "Estou com fome", "i'm tired": "Estou cansado",
    "i'm happy": "Estou feliz", "i'm glad": "Fico feliz", "i love you": "Eu te amo",
    "i like you": "Eu gosto de você", "i hate you": "Eu te odeio", "me": "Eu", "you": "Você", "him": "Ele", "her": "Ela",
    // Reações e xingamentos leves
    "oh no": "Ah, não", "oh my god": "Meu Deus", "my god": "Meu Deus", "oh my": "Nossa", "thank god": "Graças a Deus",
    "thank goodness": "Graças a Deus", "damn": "Droga", "damn it": "Droga", "crap": "Droga", "idiot": "Idiota",
    "you idiot": "Seu idiota", "fool": "Tolo", "stupid": "Idiota", "bastard": "Desgraçado", "impossible": "Impossível",
    "incredible": "Incrível", "amazing": "Incrível", "great": "Ótimo", "good": "Bom", "good job": "Bom trabalho",
    "well done": "Muito bem", "nice": "Legal", "cool": "Legal", "awesome": "Demais", "cute": "Fofo",
    "scary": "Assustador", "congratulations": "Parabéns", "happy birthday": "Feliz aniversário",
    // Conectivos
    "so": "Então", "well": "Bem", "then": "Então", "but": "Mas", "and": "E", "however": "Porém",
    // Interjeições
    "huh": "Hã", "eh": "Hã", "ha": "Ha", "hah": "Ha", "haha": "Haha", "hahaha": "Hahaha", "hehe": "Hehe", "heh": "Heh",
    "ah": "Ah", "ahh": "Ahh", "aah": "Aah", "oh": "Oh", "ooh": "Ooh", "uh": "Hã", "um": "Hum", "uh-huh": "Aham",
    "uh-oh": "Ih", "hm": "Hm", "hmm": "Hmm", "hmph": "Hmph", "mmm": "Mmm", "tch": "Tsc", "tsk": "Tsc",
    "ugh": "Urgh", "argh": "Argh", "gah": "Gah", "eek": "Iih", "ow": "Ai", "ouch": "Ai", "wow": "Uau",
    "whoa": "Uou", "yay": "Oba", "hooray": "Viva", "phew": "Ufa", "oops": "Ops", "shh": "Shh", "psst": "Psiu",
    "ahem": "Ahem", "yikes": "Credo", "geez": "Nossa", "jeez": "Nossa", "gosh": "Nossa", "fufu": "Fufu",
    "man": "Cara", "dude": "Cara", "buddy": "Amigo"
  }
};

class DicionarioFalas {
  constructor(inicial = DICIONARIO_INICIAL) {
    this.inicial = inicial;
    this.aprendidas = null;
    this._carga = null;
    this._timer = null;
  }

  /** Aspas/reticências tipográficas viram ASCII e os espaços são compactados. */
  static unificar(t) {
    return String(t || "").replace(/[‘’´`]/g, "'").replace(/[“”]/g, '"').replace(/\u2026/g, "...")
      .replace(/\s+/g, " ").trim();
  }

  /** Separa pontuação das pontas e o miolo (minúsculo): "...Hey?!" -> { prefixo "...", core "hey", sufixo "?!" }. */
  static partir(texto) {
    const t = DicionarioFalas.unificar(texto);
    const prefixo = t.match(PREFIXO_FALA)[0];
    const resto = t.slice(prefixo.length);
    const sufixo = resto.match(SUFIXO_FALA)[0];
    return {
      core: resto.slice(0, resto.length - sufixo.length).toLowerCase(),
      prefixo: prefixo.replace(/\s+/g, ""),
      sufixo: sufixo.replace(/\s+/g, "")
    };
  }

  /** Chave da camada aprendida: texto inteiro (com pontuação), sem diferenciar maiúsculas. */
  static chaveExata(origem, destino, texto) {
    return `${origem}>${destino}\x1f${DicionarioFalas.unificar(texto).toLowerCase().replace(/\s+([.,!?;:])/g, "$1")}`;
  }

  /** Fala curta o bastante para ser "frequente" (CJK não usa espaços: limite menor de caracteres). */
  static eCurta(texto) {
    const t = DicionarioFalas.unificar(texto);
    const cjk = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(t);
    return t.length > 0 && t.length <= (cjk ? 12 : 30) && t.split(" ").length <= 4;
  }

  /** Devolve a tradução ou null. Camada embutida primeiro, depois a aprendida. */
  async buscar(origem, destino, texto) {
    const { core, prefixo, sufixo } = DicionarioFalas.partir(texto);
    if (!core || core.length > 40) return null;

    const emb = this.inicial[`${origem}>${destino}`];
    if (emb && tem(emb, core)) return prefixo + emb[core] + sufixo;

    const ap = await this._carregar();
    const e = ap[DicionarioFalas.chaveExata(origem, destino, texto)];
    if (!e) return null;
    e.n++; e.u = Date.now();
    this._agendar();
    return e.t;
  }

  /** Registra uma fala curta traduzida por DeepL/Gemini. Mantém a primeira tradução aprendida. */
  async aprender(origem, destino, original, traducao) {
    const t = String(traducao || "").trim();
    if (!t || t.length > MAX_TRADUCAO_APRENDIDA) return;
    if (!DicionarioFalas.eCurta(original) || !/\p{L}/u.test(original)) return;
    const { core } = DicionarioFalas.partir(original);
    const emb = this.inicial[`${origem}>${destino}`];
    if (!core || (emb && tem(emb, core))) return; // já coberta pela lista embutida
    const ap = await this._carregar();
    const k = DicionarioFalas.chaveExata(origem, destino, original);
    if (ap[k]) return;
    ap[k] = { t, n: 1, u: Date.now() };
    this._agendar();
  }

  async info() {
    const ap = await this._carregar();
    const embutidas = Object.values(this.inicial).reduce((s, m) => s + Object.keys(m).length, 0);
    return { embutidas, aprendidas: Object.keys(ap).length };
  }

  async limparAprendidas() {
    const ap = await this._carregar();
    for (const k of Object.keys(ap)) delete ap[k]; // no próprio objeto: _carregar() sempre devolve este
    clearTimeout(this._timer);
    this._timer = null;
    try { await chrome.storage.local.remove(CHAVE_APRENDIDAS); } catch { /* sem storage */ }
  }

  _carregar() {
    this._carga ??= chrome.storage.local.get(CHAVE_APRENDIDAS)
      .then((r) => (this.aprendidas = Object.assign(Object.create(null), r?.[CHAVE_APRENDIDAS] || {})))
      .catch(() => (this.aprendidas = Object.create(null)));
    return this._carga;
  }

  _agendar() {
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.persistir().catch(() => {}); }, 1500);
  }

  async persistir() {
    const ap = this.aprendidas;
    if (!ap) return;
    const chaves = Object.keys(ap);
    if (chaves.length > MAX_APRENDIDAS) { // poda: menos usadas primeiro, depois as mais antigas
      chaves.sort((a, b) => ap[a].n - ap[b].n || ap[a].u - ap[b].u)
        .slice(0, chaves.length - Math.floor(MAX_APRENDIDAS * 0.9))
        .forEach((k) => delete ap[k]);
    }
    await chrome.storage.local.set({ [CHAVE_APRENDIDAS]: { ...ap } });
  }
}
