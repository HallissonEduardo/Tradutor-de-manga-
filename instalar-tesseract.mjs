// Baixa o Tesseract.js (v5), os núcleos WASM e os modelos de idioma para lib/tesseract/.
// Uso:  node instalar-tesseract.mjs                 (eng, jpn, jpn_vert, spa, kor, chi_sim)
//       node instalar-tesseract.mjs eng jpn_vert    (somente os idiomas indicados)
//       node instalar-tesseract.mjs --forcar        (baixa de novo mesmo se já existir)
// Requer Node 18+.
import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = dirname(fileURLToPath(import.meta.url));
const destino = join(raiz, "lib", "tesseract");
const args = process.argv.slice(2);
const forcar = args.includes("--forcar");
const pedidos = args.filter((a) => !a.startsWith("--"));
const idiomas = pedidos.length ? pedidos : ["eng", "jpn", "jpn_vert", "spa", "kor", "chi_sim"];

const JS = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/";
const CORE = "https://cdn.jsdelivr.net/npm/tesseract.js-core@5/";

const arquivos = [
  { nome: "tesseract.min.js", urls: [JS + "tesseract.min.js"] },
  { nome: "worker.min.js", urls: [JS + "worker.min.js"] },
  ...[
    "tesseract-core.wasm.js",
    "tesseract-core-simd.wasm.js",
    "tesseract-core-lstm.wasm.js",
    "tesseract-core-simd-lstm.wasm.js"
  ].map((n) => ({ nome: n, urls: [CORE + n] })),
  ...idiomas.map((l) => ({
    nome: `lang/${l}.traineddata.gz`,
    urls: [
      `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${l}/4.0.0_best_int/${l}.traineddata.gz`,
      `https://tessdata.projectnaptha.com/4.0.0_best_int/${l}.traineddata.gz`
    ]
  }))
];

async function existe(caminho) {
  try { return (await stat(caminho)).size > 1000; } catch { return false; }
}

async function baixar(urls) {
  let ultimo;
  for (const url of urls) {
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 1000) throw new Error("arquivo pequeno demais");
        return buf;
      } catch (e) {
        ultimo = new Error(`${url}: ${e.message}`);
        await new Promise((ok) => setTimeout(ok, 800 * tentativa));
      }
    }
  }
  throw ultimo;
}

await mkdir(join(destino, "lang"), { recursive: true });
let falhas = 0;

for (const { nome, urls } of arquivos) {
  const caminho = join(destino, nome);
  if (!forcar && (await existe(caminho))) { console.log(`= ${nome} (já existe)`); continue; }
  try {
    const dados = await baixar(urls);
    await writeFile(caminho, dados);
    console.log(`+ ${nome} (${(dados.length / 1048576).toFixed(2)} MB)`);
  } catch (e) {
    falhas++;
    console.error(`! ${nome}: ${e.message}`);
  }
}

if (falhas) {
  console.error(`\n${falhas} arquivo(s) falharam. Verifique a conexão e execute de novo.`);
  process.exit(1);
}
console.log("\nTesseract instalado em lib/tesseract/. Recarregue a extensão em chrome://extensions.");
