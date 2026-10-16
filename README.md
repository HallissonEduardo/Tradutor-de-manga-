# MangaLens

Extensão do Chrome que traduz balões de mangá, manhua e webtoon direto na página, sem sair do leitor.

## O que faz o projeto

- Lê o texto dos balões com OCR local e desenha a tradução sobre o texto original, usando a cor de fundo do balão e uma fonte ajustada ao espaço disponível.
- Tem dois modos: **tradução única** (você arrasta para selecionar a área) e **monitor automático** (observa a janela inteira e traduz sozinho quando a página muda).
- Guarda o que já traduziu para não gastar chamadas de API: falas repetidas e parecidas são resolvidas localmente.
- Suporta origem em inglês, japonês (inclusive vertical), coreano, chinês e espanhol, com destino em português do Brasil, inglês ou espanhol.

## Com o que foi feito

- JavaScript puro, Chrome Extension **Manifest V3** (Chrome 116+).
- **Tesseract.js** (WebAssembly) para o OCR, executado em um documento offscreen.
- **IndexedDB** para o cache de traduções e `chrome.storage` para configurações, métricas e falas aprendidas.
- APIs opcionais de tradução: **DeepL**, **Gemini** (inclusive leitura de imagem) e **MyMemory**.

Estrutura principal:

| Pasta / arquivo | Função |
| --- | --- |
| `background/service_worker.js` | Orquestra captura, OCR e a cadeia de tradução |
| `content/overlay.js` e `estilos.css` | Seleção de área, monitor e balões de tradução na página |
| `lib/tradutor.js` | Chamadas ao DeepL, Gemini e MyMemory, com bloqueios por cota |
| `lib/dicionario.js` | Dicionário de falas frequentes (lista embutida + falas aprendidas) |
| `lib/frases.js` | Divisão em frases e cache aproximado (trigramas) |
| `lib/db_cache.js` | Cache de traduções no IndexedDB (limite de 10.000 entradas, LRU) |
| `lib/recorte_imagem.js` | Recorte, pré-processamento para OCR e amostragem de cores |
| `lib/metricas.js` | Contadores de quanto cada etapa resolveu |
| `pages/` | Página de opções e documento do OCR |
| `instalar-tesseract.mjs` | Baixa o Tesseract.js e os modelos de idioma |

## Por que foi construído, quais problemas ele resolve

Extensões de tradução de mangá costumam impor um limite muito baixo de traduções para usuários gratuitos. O MangaLens foi feito para contornar isso:

- O OCR roda no seu computador, sem custo e sem limite.
- Cada frase passa por uma cascata: primeiro as etapas locais, que não custam nada (**dicionário → cache exato → cache aproximado**), e só depois as APIs, da melhor qualidade para a menor (**DeepL → Gemini → MyMemory**). Só a frase inédita chega à API.
- O MyMemory é gratuito, mas fica por último por ter qualidade menor e cota diária limitada. Se o Gemini ou o DeepL atingem a cota, são pausados automaticamente e o MyMemory assume. A tradução dele não é guardada no cache, para não substituir uma melhor depois.
- Com o uso, o cache cresce e a maior parte das falas deixa de precisar de API.

## Instruções de instalação

### Pela versão pronta

1. Baixe o `MangaLens.zip` em [Releases](https://github.com/HallissonEduardo/Tradutor-de-manga-/releases/latest) (ou pela [página do projeto](https://hallissoneduardo.github.io/Tradutor-de-manga-/)).
2. Descompacte o ZIP em uma pasta.
3. Abra `chrome://extensions` e ative o **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactação** e escolha a pasta descompactada.

### A partir do código-fonte

1. Clone o repositório:
   ```bash
   git clone https://github.com/HallissonEduardo/Tradutor-de-manga-.git
   ```
2. Instale o Tesseract e os modelos de idioma (requer Node 18+):
   ```bash
   node instalar-tesseract.mjs                 # eng, jpn, jpn_vert, spa, kor, chi_sim
   node instalar-tesseract.mjs eng jpn_vert    # somente os idiomas indicados
   ```
3. Carregue a pasta em `chrome://extensions` como descrito acima.

### Chaves de API (opcionais)

A extensão funciona sem chaves, usando OCR, cache e MyMemory. Para traduções melhores, cadastre nas **Opções**:

- [Chave do Gemini](https://aistudio.google.com/apikey) (Google AI Studio)
- [Chave do DeepL](https://www.deepl.com/pro-api) (plano Free)

As chaves ficam salvas apenas neste navegador (`storage.local`), não sincronizam com a conta Google e nunca são expostas às páginas.

## Instruções de uso

1. Abra uma página de mangá e pressione **Alt+T** (ou clique no ícone da extensão).
2. No modo **Tradução única**, arraste para selecionar o balão ou a área. A tradução aparece sobre o texto original.
3. No modo **Monitorar janela (automático)**, a extensão observa a janela inteira e traduz quando a página muda (rolagem, clique, teclado ou troca de imagem). O indicador no canto tem os botões *Retraduzir*, *Seleção manual* e *Parar*.
4. Clique em uma tradução para fechá-la (modo único) ou para alternar entre ela e o original (modo automático).
5. Pressione **ESC** para sair.

Nas **Opções** você configura:

- Idioma de origem e de destino, e texto japonês vertical.
- Modo de tradução: *Híbrido* (cache → DeepL → Gemini → MyMemory), *Gemini* (cache → Gemini → MyMemory) ou *MyMemory* (cache → MyMemory).
- Intervalo do modo automático, de 1 a 30 segundos.
- Exportar, importar e limpar o cache (formato compatível com a versão desktop) e limpar as falas aprendidas.

### Privacidade

- O OCR é feito localmente. A imagem só é enviada ao **Gemini** quando o OCR sai fraco e há chave cadastrada.
- Os textos lidos são enviados ao DeepL, Gemini ou MyMemory, conforme o modo escolhido.
- O cache fica no seu navegador e é único para todos os sites.

### Próximas versões

- Atalho **Alt+S** para seleção manual.
- Dicionário embutido de japonês, como o de inglês.

## Licença

Distribuído sob a licença **MIT**. Consulte o arquivo [LICENSE](LICENSE).

## Quais padrões seguir para contribuir

1. Abra uma *issue* descrevendo o bug ou a ideia antes de enviar mudanças grandes.
2. Faça um *fork*, crie uma branch a partir da principal (`feature/nome` ou `fix/nome`) e envie um *pull request* com uma descrição clara do que mudou e como testar.
3. Siga o estilo do código existente:
   - Nomes de classes, funções, variáveis e comentários em **português**.
   - Uma responsabilidade por módulo (`lib/`), sem dependências externas além do Tesseract.js.
   - Comentário explicando o **porquê** das regras não óbvias (limiares, limites de API, bloqueios).
4. Nunca inclua chaves de API, dados pessoais ou arquivos de cache no repositório.
5. Respeite a ordem da cascata de tradução (etapas locais primeiro, depois as APIs da melhor qualidade para a menor) e não adicione chamadas de API sem passar antes pelo cache.
6. Teste manualmente antes de enviar: recarregue a extensão em `chrome://extensions` e verifique os modos único e automático, sem erros no console do service worker.
7. Se mudar o comportamento, atualize este README e a documentação do projeto.
