/**
 * GRCON Flow — importação assistida de e-mails preparados pelo Power Automate.
 *
 * O Power Automate salva cada mensagem numa fila sincronizada pelo OneDrive.
 * O formato preferencial usa arquivos planos com o mesmo prefixo de pacote,
 * pois o conector padrão do OneDrive for Business não cria subpastas. O leitor
 * também continua aceitando o formato antigo em subpastas.
 * Nada é enviado diretamente do Microsoft 365 ao Supabase: a equipe abre o
 * painel, revisa os dados e confirma o registro. O navegador lê e grava apenas
 * a pasta escolhida pela pessoa, mediante a File System Access API.
 */
(function (root) {
  "use strict";

  const Ui = root.FlowUi;
  const Api = root.FlowApi;
  const Docs = root.FlowDocs;
  const Parser = root.FlowQuickParse;
  const { elemento, avisar, texto } = Ui;

  const BANCO_LOCAL = "grcon-flow-local";
  const VERSAO_BANCO = 1;
  const ARMAZEM = "directory-handles";
  const CHAVE_FILA = "outlook-onedrive-queue";
  const ARQUIVO_MENSAGEM = "mensagem.json";
  const ARQUIVO_PRONTO = "pronto.json";
  const ARQUIVO_IMPORTADO = "importado.json";
  const SEPARADOR_PACOTE = "__";
  const MARCADOR_ANEXO = `${SEPARADOR_PACOTE}anexo${SEPARADOR_PACOTE}`;
  const MARCADOR_INLINE = "true__";
  const MARCADOR_NORMAL = "false__";
  const EXTENSOES_IGNORADAS = new Set(["json", "tmp", "ini"]);

  // Os três idiomas do aviso corporativo. Cada padrão liga a abertura da frase
  // ao nome do grupo dentro de uma janela curta: é essa âncora que impede
  // apagar um pedido legítimo que apenas mencione "confidencial", "anexo" ou o
  // nome da empresa. A janela usa `[\s\S]` porque o Outlook quebra a frase em
  // várias linhas conforme a largura da janela de quem escreveu.
  const AVISOS_CONFIDENCIALIDADE = Object.freeze([
    /\bas?\s+informa[cç](?:[oõ]es|[aã]o)\s+contidas?\s+n(?:est|ess)[ae]\s+mensagem[\s\S]{0,400}?andrade\s+gutierrez/i,
    /\bthe\s+information\s+contained\s+in\s+this\s+(?:message|e-?mail)[\s\S]{0,400}?andrade\s+gutierrez/i,
    /\bla\s+informaci[oó]n\s+contenida\s+en\s+este\s+mensaje[\s\S]{0,400}?andrade\s+gutierrez/i,
  ]);
  // Segunda condição: o trecho precisa falar de confidencialidade ou de posse.
  // Sem isso, "As informações contidas nesta mensagem sobre a Andrade Gutierrez
  // estão erradas" seria tratada como rodapé.
  const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const PROVA_DE_AVISO = /confidenci|confidential|pertenc|pertenec|belongs|destinat|exclusiv|privileged/i;
  const ENDERECO_CORPORATIVO = /(?:\bRNEST[ \t]*)?(?:https?:\/\/)?www\.consagsa\.com\.br\/?/gi;
  // Onde termina o bloco do aviso: o fim do parágrafo, o começo de uma mensagem
  // citada, ou o fim do texto. Cortar por bloco — e não do primeiro aviso até o
  // fim — é o que preserva o pedido que vem depois numa cadeia encaminhada.
  const RETOMADA_DE_MENSAGEM =
    /\n[ \t]*(?:_{5,}|-{3,}[ \t]*(?:mensagem|original|forwarded)|(?:de|from|enviada?|sent|para|to|assunto|subject)[ \t]*:)/i;

  let destinoAtual = null;
  let tiposAtuais = [];
  let aoRegistrarAtual = null;
  let handleFila = null;
  let pacotes = [];
  let importando = false;

  function abrirBanco() {
    return new Promise((resolve, reject) => {
      if (!root.indexedDB) { reject(new Error("Este navegador não permite guardar a pasta escolhida.")); return; }
      const pedido = root.indexedDB.open(BANCO_LOCAL, VERSAO_BANCO);
      pedido.onupgradeneeded = () => {
        if (!pedido.result.objectStoreNames.contains(ARMAZEM)) pedido.result.createObjectStore(ARMAZEM);
      };
      pedido.onsuccess = () => resolve(pedido.result);
      pedido.onerror = () => reject(pedido.error || new Error("Não foi possível abrir a configuração local."));
    });
  }

  async function lerHandle() {
    const banco = await abrirBanco();
    return new Promise((resolve, reject) => {
      const transacao = banco.transaction(ARMAZEM, "readonly");
      const pedido = transacao.objectStore(ARMAZEM).get(CHAVE_FILA);
      pedido.onsuccess = () => resolve(pedido.result || null);
      pedido.onerror = () => reject(pedido.error || new Error("Não foi possível recuperar a pasta."));
      transacao.oncomplete = () => banco.close();
    });
  }

  async function guardarHandle(handle) {
    const banco = await abrirBanco();
    return new Promise((resolve, reject) => {
      const transacao = banco.transaction(ARMAZEM, "readwrite");
      transacao.objectStore(ARMAZEM).put(handle, CHAVE_FILA);
      transacao.oncomplete = () => { banco.close(); resolve(); };
      transacao.onerror = () => { banco.close(); reject(transacao.error || new Error("Não foi possível guardar a pasta.")); };
    });
  }

  async function permissao(handle, solicitar = false) {
    if (!handle) return false;
    const opcoes = { mode: "readwrite" };
    if (typeof handle.queryPermission === "function" && await handle.queryPermission(opcoes) === "granted") return true;
    if (solicitar && typeof handle.requestPermission === "function") {
      return await handle.requestPermission(opcoes) === "granted";
    }
    return false;
  }

  function htmlParaTexto(valor) {
    const bruto = String(valor || "");
    if (!/<[a-z][\s\S]*>/i.test(bruto) || typeof root.DOMParser !== "function") return bruto.trim();
    try {
      const documento = new root.DOMParser().parseFromString(bruto, "text/html");
      documento.querySelectorAll("script,style,head").forEach((no) => no.remove());
      return String(documento.body && documento.body.textContent || "")
        .replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    } catch (_) {
      return bruto.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }
  }

  /**
   * Caracteres que o Outlook insere e ninguém vê: espaço de largura zero,
   * juntor, marca de ordem de bytes e espaço inquebrável. Um único deles no
   * meio de "informações" fazia o aviso inteiro passar batido.
   */
  function semInvisiveis(valor) {
    return String(valor || "")
      .replace(/[\u200B-\u200F\u2028\u2029\uFEFF\u00AD]/g, "")
      .replace(/[\u00A0\u2007\u202F]/g, " ")
      .replace(/\r\n?/g, "\n");
  }

  function primeiroAviso(texto) {
    let inicio = -1;
    AVISOS_CONFIDENCIALIDADE.forEach((padrao) => {
      const achado = padrao.exec(texto);
      if (!achado || !PROVA_DE_AVISO.test(achado[0])) return;
      if (inicio < 0 || achado.index < inicio) inicio = achado.index;
    });
    return inicio;
  }

  function fimDoBloco(texto, inicio) {
    const resto = texto.slice(inicio);
    const limites = [resto.search(/\n[ \t]*\n/), resto.search(RETOMADA_DE_MENSAGEM)]
      .filter((posicao) => posicao >= 0);
    return limites.length ? inicio + Math.min(...limites) : texto.length;
  }

  /**
   * Retira o aviso corporativo do corpo do e-mail, em português, inglês e
   * espanhol, sem levar junto a solicitação.
   *
   * Cada aviso é removido como um bloco próprio, e não do primeiro aviso até o
   * fim do texto: numa mensagem encaminhada o pedido de verdade costuma estar
   * *abaixo* do rodapé da mensagem de cima, e truncar ali apagava exatamente o
   * que a equipe precisa ler. O endereço corporativo sai sempre, mesmo quando a
   * frase do aviso não vem junto.
   */
  function removerAvisoConfidencialidade(valor) {
    let atual = semInvisiveis(valor);
    for (let volta = 0; volta < 8; volta += 1) {
      const inicio = primeiroAviso(atual);
      if (inicio < 0) break;
      atual = atual.slice(0, inicio) + atual.slice(fimDoBloco(atual, inicio));
    }
    return atual
      .replace(ENDERECO_CORPORATIVO, "")
      .replace(/[ \t]*(?:aviso\s+de\s+confidencialidade|disclaimer)\s*:[ \t]*$/gim, "")
      .replace(/^[ \t]*[-_=–—*]{3,}[ \t]*$/gm, "")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function primeiro(objeto, chaves) {
    for (const chave of chaves) {
      const valor = objeto && objeto[chave];
      if (valor !== null && valor !== undefined && valor !== "") return valor;
    }
    return "";
  }

  function remetenteDe(mensagem) {
    const bruto = primeiro(mensagem, ["from", "From", "sender", "Sender", "remetente"]);
    if (bruto && typeof bruto === "object") {
      const emailAddress = bruto.emailAddress || bruto.EmailAddress || bruto;
      return {
        nome: texto(primeiro(emailAddress, ["name", "Name", "displayName", "DisplayName"])),
        email: texto(primeiro(emailAddress, ["address", "Address", "email", "Email"])),
      };
    }
    const linha = texto(bruto);
    const email = (linha.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [""])[0];
    return {
      nome: linha.replace(/<[^>]+>/g, " ").replace(email, " ").replace(/[\"']/g, "").replace(/\s+/g, " ").trim(),
      email,
    };
  }

  function normalizarMensagem(mensagem, nomePasta) {
    const remetente = remetenteDe(mensagem);
    const corpoBruto = primeiro(mensagem, ["body", "Body", "bodyContent", "BodyContent", "content", "Content"]);
    const corpoObjeto = corpoBruto && typeof corpoBruto === "object" ? corpoBruto : null;
    const corpo = removerAvisoConfidencialidade(htmlParaTexto(corpoObjeto
      ? primeiro(corpoObjeto, ["content", "Content", "body", "Body"])
      : corpoBruto || primeiro(mensagem, ["bodyPreview", "BodyPreview", "preview", "Preview"])));
    const assunto = texto(primeiro(mensagem, ["subject", "Subject", "assunto"]));
    const externalId = texto(primeiro(mensagem, [
      "internetMessageId", "InternetMessageId", "internet_message_id", "id", "Id", "messageId", "MessageId",
    ])) || nomePasta;
    const recebidoEm = texto(primeiro(mensagem, [
      "receivedDateTime", "ReceivedDateTime", "received_at", "dateTimeReceived", "DateTimeReceived",
    ]));
    const cabecalho = [
      `De: ${remetente.nome || remetente.email}${remetente.nome && remetente.email ? ` <${remetente.email}>` : ""}`,
      `Assunto: ${assunto}`,
      "",
      corpo,
    ].join("\n");
    const analise = Parser && typeof Parser.analisar === "function"
      ? Parser.analisar(cabecalho, { tipos: tiposAtuais })
      : { nome: remetente.nome, contato: remetente.email, area: "", pedido: corpo || assunto, documentos: [], titulos: [], tipoCodigo: "" };
    return {
      externalId,
      assunto: assunto || "Sem assunto",
      corpo,
      recebidoEm,
      remetenteNome: analise.nome || remetente.nome || remetente.email.split("@")[0] || "Solicitante não identificado",
      remetenteEmail: analise.contato || remetente.email,
      area: analise.area || "",
      // Mensagem longa: a análise viu só o começo, então o pedido usa o corpo
      // inteiro. Perder o final de um e-mail extenso é pior do que trazer um
      // texto que a pessoa vai revisar de qualquer forma.
      pedido: (analise.truncado ? corpo : analise.pedido) || corpo || assunto || "Mensagem recebida pelo Outlook",
      tipoCodigo: analise.tipoCodigo || "",
      documentos: [...(analise.documentos || []), ...(analise.titulos || [])],
    };
  }

  async function arquivoDaPasta(pasta, nome) {
    try {
      const handle = await pasta.getFileHandle(nome);
      return await handle.getFile();
    } catch (_) {
      return null;
    }
  }

  async function jsonDaPasta(pasta, nome) {
    const arquivo = await arquivoDaPasta(pasta, nome);
    if (!arquivo) return null;
    try {
      const lido = JSON.parse((await arquivo.text()).replace(/^\ufeff/, ""));
      return Array.isArray(lido) ? (lido[0] || null) : lido;
    } catch (_) { return null; }
  }

  function nomePlano(prefixo, nome) { return `${prefixo}${SEPARADOR_PACOTE}${nome}`; }

  function arquivoComNome(arquivo, nome) {
    if (!arquivo || arquivo.name === nome || typeof root.File !== "function") return arquivo;
    return new root.File([arquivo], nome, {
      type: arquivo.type || "application/octet-stream",
      lastModified: arquivo.lastModified || Date.now(),
    });
  }

  /**
   * Um pacote plano é um conjunto de arquivos que compartilham o prefixo. Esta
   * função diz a que pacote — e a que papel dentro dele — um nome pertence, para
   * que a fila inteira seja classificada numa única varredura do diretório.
   */
  function classificarNomePlano(nome) {
    const indiceAnexo = nome.indexOf(MARCADOR_ANEXO);
    if (indiceAnexo > 0) {
      return {
        prefixo: nome.slice(0, indiceAnexo),
        papel: "anexo",
        resto: nome.slice(indiceAnexo + MARCADOR_ANEXO.length),
      };
    }
    const minusculo = nome.toLowerCase();
    for (const arquivo of [ARQUIVO_PRONTO, ARQUIVO_MENSAGEM, ARQUIVO_IMPORTADO]) {
      const sufixo = `${SEPARADOR_PACOTE}${arquivo}`;
      if (minusculo.endsWith(sufixo)) {
        return { prefixo: nome.slice(0, -sufixo.length), papel: arquivo.replace(".json", "") };
      }
    }
    return null;
  }

  async function jsonDoHandle(entrada) {
    if (!entrada || !entrada.handle) return null;
    try {
      const arquivo = await entrada.handle.getFile();
      const lido = JSON.parse((await arquivo.text()).replace(/^\ufeff/, ""));
      return Array.isArray(lido) ? (lido[0] || null) : lido;
    } catch (_) { return null; }
  }

  function nomeDeAnexoUtil(resto) {
    const minusculo = resto.toLocaleLowerCase("pt-BR");
    if (minusculo.startsWith(MARCADOR_INLINE)) return { incorporado: true, nome: "" };
    const nome = minusculo.startsWith(MARCADOR_NORMAL) ? resto.slice(MARCADOR_NORMAL.length) : resto;
    const extensao = nome.toLowerCase().split(".").pop();
    if (!nome || EXTENSOES_IGNORADAS.has(extensao)) return { incorporado: false, nome: "" };
    return { incorporado: false, nome };
  }

  /**
   * Abre os anexos do pacote e conta o que não conseguiu abrir.
   *
   * Engolir a falha de leitura era o caminho pelo qual um anexo sumia em
   * silêncio: com o Files On-Demand do OneDrive, o arquivo na pasta é um
   * marcador on-line, e `getFile()` só o traz de verdade se houver rede. O que
   * falhou agora é contado e vira impedimento de registro, não um zero calado.
   */
  async function anexosDoGrupo(grupo) {
    const encontrados = [];
    let ilegiveis = 0;
    let incorporados = 0;
    for (const item of grupo.anexos) {
      const { incorporado, nome } = nomeDeAnexoUtil(item.resto);
      if (incorporado) { incorporados += 1; continue; }
      if (!nome) continue;
      try { encontrados.push(arquivoComNome(await item.handle.getFile(), nome)); }
      catch (_) { ilegiveis += 1; }
    }
    encontrados.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    return { anexos: encontrados, ilegiveis, incorporados };
  }

  async function anexosDaPasta(pasta) {
    const encontrados = [];
    let ilegiveis = 0;
    let incorporados = 0;
    for await (const [nome, handle] of pasta.entries()) {
      if (!handle || handle.kind !== "file") continue;
      if ([ARQUIVO_MENSAGEM, ARQUIVO_PRONTO, ARQUIVO_IMPORTADO].includes(nome.toLowerCase())) continue;
      const { incorporado, nome: util } = nomeDeAnexoUtil(nome);
      if (incorporado) { incorporados += 1; continue; }
      if (!util) continue;
      try { encontrados.push(arquivoComNome(await handle.getFile(), util)); }
      catch (_) { ilegiveis += 1; }
    }
    encontrados.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    return { anexos: encontrados, ilegiveis, incorporados };
  }

  function documentosDosAnexos(arquivos) {
    if (!Docs || typeof Docs.deArquivos !== "function") return [];
    return Docs.deArquivos(arquivos).map((item) => texto(item && (item.document || item.requested_title))).filter(Boolean);
  }

  function chaveDocumento(valor) {
    return Docs && Docs.chave ? Docs.chave(valor) : texto(valor).toUpperCase();
  }

  /**
   * O pacote só pode ser registrado quando está inteiro.
   *
   * O marcador da versão 2 traz `attachment_count`, gravado pelo Power Automate
   * depois de criar os arquivos. Comparar esse número com o que a fila tem é a
   * única forma de distinguir "o e-mail não tinha anexo" de "o anexo ainda não
   * sincronizou". Pacote da versão 1, sem contagem, mantém o comportamento
   * anterior — mas um arquivo ilegível continua impedindo o registro.
   */
  function impedimentoDoPacote(pronto, presentes, leitura) {
    const esperados = Number(pronto && pronto.attachment_count);
    if (Number.isFinite(esperados) && esperados > presentes) {
      const faltam = esperados - presentes;
      return `Pacote incompleto: ${faltam} de ${esperados} anexo(s) ainda não chegaram à fila. Aguarde a sincronização do OneDrive.`;
    }
    if (leitura.ilegiveis) {
      return `${leitura.ilegiveis} anexo(s) estão na pasta mas não puderam ser lidos. Marque a pasta como “Sempre manter neste dispositivo” e sincronize de novo.`;
    }
    return "";
  }

  async function carregarPacote(nome, pasta) {
    if (!await arquivoDaPasta(pasta, ARQUIVO_PRONTO)) return null;
    const mensagem = await jsonDaPasta(pasta, ARQUIVO_MENSAGEM);
    if (!mensagem) return { nome, pasta, erro: "mensagem.json inválido ou indisponível." };
    const pronto = await jsonDaPasta(pasta, ARQUIVO_PRONTO);
    const importado = await jsonDaPasta(pasta, ARQUIVO_IMPORTADO);
    const leitura = await anexosDaPasta(pasta);
    const dados = normalizarMensagem(mensagem, nome);
    dados.documentos = [...new Set([...dados.documentos, ...documentosDosAnexos(leitura.anexos)].map(texto).filter(Boolean))];
    // "Presentes" conta tudo que está na pasta — inclusive a assinatura e o que
    // não pôde ser aberto —, porque é isso que a contagem do marcador declara.
    const presentes = leitura.anexos.length + leitura.incorporados + leitura.ilegiveis;
    const incompleto = impedimentoDoPacote(pronto, presentes, leitura);
    return {
      nome, pasta, mensagem, dados, anexos: leitura.anexos, importado,
      incorporados: leitura.incorporados, incompleto,
      importadoNome: ARQUIVO_IMPORTADO,
      selecionado: !importado && !incompleto, erro: "",
    };
  }

  async function carregarPacotePlano(prefixo, grupo) {
    const importadoNome = nomePlano(prefixo, ARQUIVO_IMPORTADO);
    const base = { nome: prefixo, pasta: handleFila, importadoNome };
    const pronto = await jsonDoHandle(grupo.pronto);
    if (!pronto) {
      return { ...base, erro: `${nomePlano(prefixo, ARQUIVO_PRONTO)} ainda não pôde ser lido. Aguarde a sincronização do OneDrive.` };
    }
    if (!grupo.mensagem) {
      return { ...base, erro: `${nomePlano(prefixo, ARQUIVO_MENSAGEM)} ainda não chegou à fila.` };
    }
    const mensagem = await jsonDoHandle(grupo.mensagem);
    if (!mensagem) {
      return { ...base, erro: `${nomePlano(prefixo, ARQUIVO_MENSAGEM)} inválido ou indisponível.` };
    }
    const importado = await jsonDoHandle(grupo.importado);
    const leitura = await anexosDoGrupo(grupo);
    const dados = normalizarMensagem(mensagem, prefixo);
    dados.documentos = [...new Set([...dados.documentos, ...documentosDosAnexos(leitura.anexos)].map(texto).filter(Boolean))];
    const incompleto = impedimentoDoPacote(pronto, grupo.anexos.length, leitura);
    return {
      ...base, mensagem, dados, anexos: leitura.anexos, importado,
      incorporados: leitura.incorporados, incompleto,
      selecionado: !importado && !incompleto, erro: "",
    };
  }

  /**
   * Lê a fila inteira numa varredura só.
   *
   * A versão anterior reenumerava o diretório para cada pacote ao procurar os
   * anexos pelo prefixo: com a fila crescendo — e nada a limpa — o custo subia
   * ao quadrado e "Sincronizar" passava a levar minutos. Agora o diretório é
   * percorrido uma vez e os arquivos são agrupados pelo prefixo em memória.
   */
  async function lerFila() {
    const grupos = new Map();
    const pastas = [];
    for await (const [nome, handle] of handleFila.entries()) {
      if (!handle) continue;
      if (handle.kind === "directory") { pastas.push([nome, handle]); continue; }
      if (handle.kind !== "file") continue;
      const parte = classificarNomePlano(nome);
      if (!parte || !parte.prefixo) continue;
      if (!grupos.has(parte.prefixo)) grupos.set(parte.prefixo, { anexos: [] });
      const grupo = grupos.get(parte.prefixo);
      if (parte.papel === "anexo") grupo.anexos.push({ nome, handle, resto: parte.resto });
      else grupo[parte.papel] = { nome, handle };
    }

    const resultado = [];
    for (const [nome, handle] of pastas) {
      const pacote = await carregarPacote(nome, handle);
      if (pacote) resultado.push(pacote);
    }
    for (const [prefixo, grupo] of grupos) {
      // Sem `__pronto.json` o Power Automate ainda não terminou de gravar.
      if (!grupo.pronto) continue;
      resultado.push(await carregarPacotePlano(prefixo, grupo));
    }

    resultado.sort((a, b) => {
      const ai = Boolean(a.importado && a.importado.status === "concluido");
      const bi = Boolean(b.importado && b.importado.status === "concluido");
      if (ai !== bi) return ai ? 1 : -1;
      return String(b.dados && b.dados.recebidoEm || b.nome).localeCompare(String(a.dados && a.dados.recebidoEm || a.nome));
    });
    const pendentes = resultado.filter((pacote) => !(pacote.importado && pacote.importado.status === "concluido"));
    const concluidos = resultado.filter((pacote) => pacote.importado && pacote.importado.status === "concluido");
    return [...pendentes, ...concluidos.slice(0, 50)];
  }

  function tamanho(bytes) {
    const valor = Math.max(0, Number(bytes) || 0);
    if (valor < 1024 * 1024) return `${Math.max(1, Math.round(valor / 1024))} KB`;
    return `${(valor / (1024 * 1024)).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
  }

  function dataRecebida(valor) {
    const data = new Date(valor);
    if (Number.isNaN(data.getTime())) return texto(valor) || "Data não informada";
    return data.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  }

  function idCampo(indice, sufixo) { return `outlook-${indice}-${sufixo}`; }

  function valorCampo(indice, sufixo) {
    return texto(document.getElementById(idCampo(indice, sufixo))?.value);
  }

  function seletorTipo(indice, selecionado) {
    // Sem `aria-label`: o <label for> já diz "Tipo *", e o rótulo ARIA vencia o
    // visível, escondendo do leitor de tela que o campo é obrigatório.
    const seletor = elemento("select", { id: idCampo(indice, "tipo"), required: true });
    seletor.append(elemento("option", { value: "", text: "Escolha o tipo…" }));
    tiposAtuais.filter((tipo) => tipo.active !== false).forEach((tipo) => {
      seletor.append(elemento("option", { value: tipo.code, text: tipo.label, selected: tipo.code === selecionado }));
    });
    return seletor;
  }

  function alternarPacote(indice, marcado) {
    const pacote = pacotes[indice];
    if (!pacote || pacote.importado || pacote.erro || pacote.incompleto) return;
    pacote.selecionado = marcado;
    atualizarResumoSelecao();
  }

  function atualizarResumoSelecao() {
    const marcados = pacotes.filter(selecionavel).length;
    const botao = document.getElementById("outlook-importar");
    const resumo = document.getElementById("outlook-selecao-resumo");
    if (botao) { botao.disabled = !marcados || importando; botao.textContent = importando ? "Registrando…" : `Registrar selecionados (${marcados})`; }
    if (resumo) resumo.textContent = marcados ? `${marcados} e-mail(s) pronto(s) para revisão e registro.` : "Selecione pelo menos um e-mail pendente.";
  }

  function avisosDoPacote(pacote) {
    return (pacote.importado && pacote.importado.warnings) || [];
  }

  /** Um pacote entra no lote quando está inteiro, pendente e sem erro de leitura. */
  function selecionavel(pacote) {
    return Boolean(pacote)
      && pacote.selecionado
      && !pacote.erro
      && !pacote.incompleto
      && !(pacote.importado && pacote.importado.status === "concluido");
  }

  function cartaoPacote(pacote, indice) {
    if (pacote.erro) {
      return elemento("article", { class: "flow-outlook-card erro" }, [
        elemento("strong", { text: pacote.nome }),
        elemento("p", { text: pacote.erro }),
      ]);
    }
    const concluido = Boolean(pacote.importado && pacote.importado.status === "concluido");
    const parcial = Boolean(pacote.importado && !concluido);
    const totalBytes = pacote.anexos.reduce((total, arquivo) => total + Number(arquivo.size || 0), 0);
    const caixa = elemento("input", {
      type: "checkbox", checked: pacote.selecionado,
      disabled: concluido || Boolean(pacote.incompleto),
      "aria-label": `Selecionar ${pacote.dados.assunto}`,
      onchange: (evento) => alternarPacote(indice, evento.target.checked),
    });
    const status = concluido
      ? elemento("span", { class: "flow-selo ok", text: pacote.importado.protocol || "Importado" })
      : pacote.incompleto
        ? elemento("span", { class: "flow-selo alerta", text: "Incompleto" })
        : parcial
          ? elemento("span", { class: "flow-selo validar", text: "Continuar importação" })
          : elemento("span", { class: "flow-selo acao", text: "Pendente" });
    const campos = concluido ? null : elemento("div", { class: "flow-outlook-campos" }, [
      elemento("label", { class: "flow-campo", for: idCampo(indice, "tipo") }, [
        elemento("span", { text: "Tipo *" }), seletorTipo(indice, pacote.dados.tipoCodigo),
      ]),
      elemento("label", { class: "flow-campo", for: idCampo(indice, "nome") }, [
        elemento("span", { text: "Solicitante *" }),
        elemento("input", { id: idCampo(indice, "nome"), value: pacote.dados.remetenteNome }),
      ]),
      elemento("label", { class: "flow-campo", for: idCampo(indice, "contato") }, [
        // Obrigatório porque `flow_create_staff_request` recusa e-mail inválido.
        // Pedir aqui é melhor do que deixar o erro do banco aparecer no meio do lote.
        elemento("span", { text: "E-mail do solicitante *" }),
        elemento("input", {
          id: idCampo(indice, "contato"), type: "email", required: true,
          value: pacote.dados.remetenteEmail,
        }),
      ]),
      elemento("label", { class: "flow-campo", for: idCampo(indice, "area") }, [
        elemento("span", { text: "Área / setor" }),
        elemento("input", { id: idCampo(indice, "area"), value: pacote.dados.area }),
      ]),
      elemento("label", { class: "flow-campo larga", for: idCampo(indice, "pedido") }, [
        elemento("span", { text: "Pedido *" }),
        elemento("textarea", { id: idCampo(indice, "pedido"), rows: "4", text: pacote.dados.pedido }),
      ]),
      elemento("label", { class: "flow-campo larga", for: idCampo(indice, "documentos") }, [
        elemento("span", { text: "Documentos ou títulos" }),
        elemento("textarea", {
          id: idCampo(indice, "documentos"), rows: "3",
          placeholder: "Um documento ou título por linha", text: pacote.dados.documentos.join("\n"),
        }),
      ]),
    ]);
    return elemento("article", { class: `flow-outlook-card${concluido ? " concluido" : ""}` }, [
      elemento("header", { class: "flow-outlook-card-head" }, [
        caixa,
        elemento("div", { class: "flow-outlook-card-identidade" }, [
          elemento("strong", { text: pacote.dados.assunto }),
          elemento("span", { text: `${pacote.dados.remetenteNome} · ${dataRecebida(pacote.dados.recebidoEm)}` }),
        ]),
        status,
      ]),
      elemento("div", { class: "flow-outlook-meta" }, [
        elemento("span", { text: `${pacote.anexos.length} anexo(s)` }),
        elemento("span", { text: tamanho(totalBytes) }),
        pacote.incorporados
          ? elemento("span", { text: `${pacote.incorporados} imagem(ns) da assinatura ignorada(s)` }) : null,
        concluido && pacote.importado.imported_at
          ? elemento("span", { text: `Registrado em ${dataRecebida(pacote.importado.imported_at)}` }) : null,
      ]),
      pacote.incompleto
        ? elemento("p", { class: "flow-outlook-status erro", text: pacote.incompleto }) : null,
      // Os avisos deixam de ser só um número no rodapé: o operador precisa saber
      // *qual* anexo ficou de fora para decidir o que fazer com ele.
      avisosDoPacote(pacote).length
        ? elemento("details", { class: "flow-outlook-anexos" }, [
          elemento("summary", { text: `${avisosDoPacote(pacote).length} aviso(s) desta importação` }),
          elemento("ul", {}, avisosDoPacote(pacote).map((aviso) => elemento("li", { text: aviso }))),
        ]) : null,
      campos,
      pacote.anexos.length ? elemento("details", { class: "flow-outlook-anexos" }, [
        elemento("summary", { text: "Ver anexos" }),
        elemento("ul", {}, pacote.anexos.map((arquivo) => elemento("li", { text: `${arquivo.name} · ${tamanho(arquivo.size)}` }))),
      ]) : null,
    ]);
  }

  function desenharFila() {
    const lista = document.getElementById("outlook-lista");
    if (!lista) return;
    if (!handleFila) {
      lista.replaceChildren(elemento("div", { class: "flow-vazio" }, [
        elemento("strong", { text: "Conecte a fila do OneDrive" }),
        elemento("p", { text: "Escolha uma única vez a pasta GRCON Flow\\Fila sincronizada neste computador." }),
      ]));
      atualizarResumoSelecao();
      return;
    }
    if (!pacotes.length) {
      lista.replaceChildren(elemento("div", { class: "flow-vazio" }, [
        elemento("strong", { text: "Nenhum e-mail pronto" }),
        elemento("p", { text: "Mova um e-mail para GRCON Flow\\Entrada no Outlook e aguarde a execução do Power Automate." }),
      ]));
      atualizarResumoSelecao();
      return;
    }
    lista.replaceChildren(...pacotes.map(cartaoPacote));
    atualizarResumoSelecao();
  }

  function atualizarConexao(mensagem, classe = "") {
    const status = document.getElementById("outlook-conexao-status");
    if (!status) return;
    status.className = `flow-outlook-status ${classe}`.trim();
    status.textContent = mensagem;
  }

  async function selecionarPasta() {
    if (typeof root.showDirectoryPicker !== "function") {
      avisar("A seleção da pasta exige Google Chrome ou Microsoft Edge atualizado.", "erro");
      return;
    }
    try {
      const handle = await root.showDirectoryPicker({ id: "grcon-flow-outlook", mode: "readwrite", startIn: "documents" });
      if (!await permissao(handle, true)) throw new Error("A pasta não foi autorizada para leitura e gravação.");
      handleFila = handle;
      await guardarHandle(handle);
      atualizarConexao(`Fila conectada: ${handle.name}`, "ok");
      await sincronizar();
    } catch (erro) {
      if (erro && erro.name === "AbortError") return;
      avisar(erro.message || "Não foi possível selecionar a fila do OneDrive.", "erro");
    }
  }

  async function sincronizar() {
    if (!handleFila) { await selecionarPasta(); return; }
    try {
      if (!await permissao(handleFila, true)) throw new Error("Autorize novamente o acesso à fila do OneDrive.");
      atualizarConexao("Lendo os pacotes concluídos…", "carregando");
      pacotes = await lerFila();
      // Saber a hora da última leitura é o que revela um fluxo do Power Automate
      // que parou: sem isso, uma fila vazia por pane e uma fila vazia por
      // tranquilidade são a mesma tela.
      const hora = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      const pendentes = pacotes.filter((pacote) => selecionavel(pacote) || (!pacote.importado && !pacote.erro)).length;
      const incompletos = pacotes.filter((pacote) => pacote.incompleto).length;
      atualizarConexao(
        `Fila conectada: ${handleFila.name} · ${pacotes.length} pacote(s), ${pendentes} pendente(s)`
        + `${incompletos ? `, ${incompletos} incompleto(s)` : ""} · última sincronização às ${hora}`,
        incompletos ? "atencao" : "ok"
      );
      desenharFila();
    } catch (erro) {
      atualizarConexao("A fila precisa ser conectada novamente.", "erro");
      avisar(erro.message || "Não foi possível ler a fila do OneDrive.", "erro");
    }
  }

  async function uuidDeterministico(valor) {
    const bytes = new root.TextEncoder().encode(String(valor || ""));
    const resumo = new Uint8Array(await root.crypto.subtle.digest("SHA-256", bytes));
    const uuid = resumo.slice(0, 16);
    uuid[6] = (uuid[6] & 0x0f) | 0x50;
    uuid[8] = (uuid[8] & 0x3f) | 0x80;
    const hex = [...uuid].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  async function gravarMarcador(pacote, dados) {
    const handle = await pacote.pasta.getFileHandle(pacote.importadoNome || ARQUIVO_IMPORTADO, { create: true });
    const gravador = await handle.createWritable();
    await gravador.write(JSON.stringify(dados, null, 2));
    await gravador.close();
    pacote.importado = dados;
  }

  function itemDoAnexo(arquivo, itensCriados) {
    const candidatos = Docs && Docs.deArquivos ? Docs.deArquivos([arquivo]) : [];
    const encontrado = candidatos.find((item) => item.document);
    if (encontrado) {
      const chave = chaveDocumento(encontrado.document);
      const correspondente = itensCriados.find((item) => chaveDocumento(item.document) === chave);
      if (correspondente && correspondente.requires_pdf_excel_pair) return correspondente.id;
    }
    const pares = itensCriados.filter((item) => item.requires_pdf_excel_pair);
    return pares.length === 1 ? pares[0].id : null;
  }

  function chaveArquivo(arquivo) { return `${arquivo.name}\u0000${Number(arquivo.size) || 0}`; }

  async function importarPacote(pacote, indice, progresso) {
    const tipo = valorCampo(indice, "tipo");
    const nome = valorCampo(indice, "nome");
    const contato = valorCampo(indice, "contato");
    const area = valorCampo(indice, "area");
    const pedido = valorCampo(indice, "pedido");
    const documentosBrutos = valorCampo(indice, "documentos");
    const clientRequestId = await uuidDeterministico(`outlook:${pacote.dados.externalId}`);
    const itens = documentosBrutos
      ? Docs.semRepetidos(Docs.daListaFlexivel(documentosBrutos)).itens
      : [];
    let marcador = pacote.importado && pacote.importado.external_id === pacote.dados.externalId
      ? { ...pacote.importado } : null;
    let solicitacao = null;

    if (!(marcador && marcador.request_id)) {
      if (!tipo) throw new Error(`Escolha o tipo de “${pacote.dados.assunto}”.`);
      if (!nome) throw new Error(`Informe o solicitante de “${pacote.dados.assunto}”.`);
      // O banco recusa contato vazio ou malformado. Conferir aqui transforma um
      // erro de RPC no meio do lote numa frase que aponta o campo.
      if (!EMAIL_VALIDO.test(contato)) {
        throw new Error(`Informe um e-mail válido para o solicitante de “${pacote.dados.assunto}”.`);
      }
      if (!pedido) throw new Error(`Informe o pedido de “${pacote.dados.assunto}”.`);
    }

    if (marcador && marcador.request_id) {
      progresso.textContent = `Retomando ${marcador.protocol || pacote.dados.assunto}…`;
      const existente = await Api.solicitacoes.obter(marcador.request_id);
      if (!existente.error && existente.data) solicitacao = existente.data;
    }

    if (!solicitacao) {
      progresso.textContent = `Criando solicitação para “${pacote.dados.assunto}”…`;
      const { data, error } = await Api.solicitacoes.criarRapida({
        tipo, nome, area, contato,
        resumo: pedido.slice(0, 300),
        descricao: pedido,
        formulario: {
          pedido_resumido: pedido,
          // O `case` de `flow_create_staff_request` reconhece este valor; com
          // qualquer outro, o rótulo gravado perde a origem Outlook.
          origem_preenchimento: "integracao_outlook",
          canal_origem: "outlook",
          outlook_external_id: pacote.dados.externalId,
          outlook_subject: pacote.dados.assunto,
          outlook_received_at: pacote.dados.recebidoEm,
          outlook_queue_folder: pacote.nome,
          _client_request_id: clientRequestId,
        },
        itens,
      });
      if (error) throw new Error(error);
      solicitacao = data;
      marcador = {
        schema_version: 1,
        status: "enviando_anexos",
        external_id: pacote.dados.externalId,
        request_id: data.id,
        protocol: data.protocol,
        imported_at: new Date().toISOString(),
        uploaded_files: [],
        warnings: [],
        triage_completed: false,
      };
      await gravarMarcador(pacote, marcador);
    }

    const detalhe = Array.isArray(solicitacao.itens) ? solicitacao.itens
      : Array.isArray(solicitacao.request_items) ? solicitacao.request_items : [];
    const jaEnviados = new Set([
      ...(marcador.uploaded_files || []),
      // `flow_attachments` guarda `file_name` e `size_bytes`. Ler `original_name`
      // e `file_size` devolvia sempre undefined, e a retomada reenviava tudo.
      ...((solicitacao.anexos || []).map((anexo) => `${texto(anexo.file_name)}\u0000${Number(anexo.size_bytes) || 0}`)),
    ]);
    const avisos = [...(marcador.warnings || [])];

    for (let posicao = 0; posicao < pacote.anexos.length; posicao += 1) {
      const arquivo = pacote.anexos[posicao];
      const chave = chaveArquivo(arquivo);
      if (jaEnviados.has(chave)) continue;
      const validacao = Api.anexos.validar(arquivo);
      if (validacao) { avisos.push(validacao); continue; }
      progresso.textContent = `${solicitacao.protocol}: anexo ${posicao + 1} de ${pacote.anexos.length} · ${arquivo.name}`;
      const itemId = itemDoAnexo(arquivo, detalhe);
      const retorno = await Api.anexos.enviar(solicitacao.id, arquivo, itemId, ({ percentual }) => {
        progresso.textContent = `${solicitacao.protocol}: ${arquivo.name} · ${percentual}%`;
      });
      if (retorno.error) {
        marcador.status = "pendente_anexos";
        marcador.warnings = [...new Set([...avisos, `${arquivo.name}: ${retorno.error}`])];
        await gravarMarcador(pacote, marcador);
        throw new Error(`${solicitacao.protocol} foi criado, mas o anexo “${arquivo.name}” ficou pendente: ${retorno.error}`);
      }
      jaEnviados.add(chave);
      marcador.uploaded_files = [...jaEnviados];
      marcador.warnings = [...new Set(avisos)];
      await gravarMarcador(pacote, marcador);
    }

    if (!marcador.triage_completed) {
      progresso.textContent = `${solicitacao.protocol}: conferindo documentos nas LDs…`;
      const triagem = await Api.triagem.solicitacao(solicitacao.id, ({ atual, total }) => {
        progresso.textContent = `${solicitacao.protocol}: triagem ${atual} de ${total}…`;
      });
      if (triagem.error) avisos.push(`Triagem pendente: ${triagem.error}`);
      else marcador.triage_completed = true;
    }

    marcador.status = "concluido";
    marcador.completed_at = new Date().toISOString();
    marcador.warnings = [...new Set(avisos)];
    await gravarMarcador(pacote, marcador);
    pacote.selecionado = false;
    return { data: solicitacao, avisos: marcador.warnings };
  }

  /**
   * Registra os pacotes selecionados, um a um, sem deixar que a falha de um
   * interrompa os demais.
   *
   * Antes, a primeira exceção abortava o laço: um cartão sem tipo escolhido
   * segurava todos os outros, e o operador precisava descobrir por tentativa
   * qual era. Agora cada pacote é tentado, o que falhou é nomeado no fim, e o
   * que deu certo permanece registrado.
   */
  async function importarSelecionados() {
    if (importando) return;
    const selecionados = pacotes
      .map((pacote, indice) => ({ pacote, indice }))
      .filter(({ pacote }) => selecionavel(pacote));
    if (!selecionados.length) return;
    importando = true;
    atualizarResumoSelecao();
    const progresso = document.getElementById("outlook-importacao-status");
    const resultados = [];
    const falhas = [];
    try {
      for (let posicao = 0; posicao < selecionados.length; posicao += 1) {
        const { pacote, indice } = selecionados[posicao];
        progresso.className = "flow-outlook-status carregando";
        progresso.textContent = `Registrando e-mail ${posicao + 1} de ${selecionados.length}…`;
        try {
          resultados.push(await importarPacote(pacote, indice, progresso));
        } catch (erro) {
          falhas.push(erro && erro.message ? erro.message : `Falha ao registrar “${pacote.dados.assunto}”.`);
        }
      }
      const avisos = resultados.flatMap((resultado) => resultado.avisos || []);
      const partes = [`${resultados.length} solicitação(ões) registrada(s).`];
      if (avisos.length) partes.push(`${avisos.length} aviso(s) para conferência — abra o cartão para ver quais.`);
      if (falhas.length) partes.push(`${falhas.length} não registrada(s): ${falhas.join(" ")}`);
      progresso.className = `flow-outlook-status ${falhas.length ? "erro" : avisos.length ? "atencao" : "ok"}`;
      progresso.textContent = partes.join(" ");
      if (resultados.length) avisar(`${resultados.length} solicitação(ões) importada(s) do Outlook.`, "ok");
      if (falhas.length) avisar(falhas[0], "erro");
      if (typeof aoRegistrarAtual === "function" && resultados.length) {
        await aoRegistrarAtual(resultados[resultados.length - 1].data);
      }
    } finally {
      importando = false;
      desenharFila();
    }
  }

  async function restaurarPasta() {
    try {
      const salvo = await lerHandle();
      if (salvo) {
        handleFila = salvo;
        const autorizado = await permissao(salvo, false);
        atualizarConexao(autorizado ? `Fila conectada: ${salvo.name}` : `Fila lembrada: ${salvo.name} · clique em Sincronizar`, autorizado ? "ok" : "");
        if (autorizado) await sincronizar();
      } else atualizarConexao("Nenhuma fila conectada.");
    } catch (_) {
      atualizarConexao("Nenhuma fila conectada.");
    }
  }

  function montar(destino, { tipos = [], aoRegistrar = null } = {}) {
    destinoAtual = destino;
    tiposAtuais = tipos;
    aoRegistrarAtual = aoRegistrar;
    pacotes = [];
    importando = false;
    destino.replaceChildren(
      elemento("section", { class: "flow-outlook-integracao" }, [
        elemento("div", { class: "flow-outlook-intro" }, [
          elemento("div", {}, [
            elemento("h2", { text: "Outlook → GRCON Flow" }),
            elemento("p", { text: "Revise e registre os e-mails que o Power Automate preparou no OneDrive. Nada entra no painel sem sua confirmação." }),
          ]),
          elemento("div", { class: "flow-acoes" }, [
            elemento("button", { class: "secondary-button compact", type: "button", text: "Conectar pasta do OneDrive", onclick: selecionarPasta }),
            elemento("button", { class: "primary-button compact", type: "button", text: "Sincronizar e-mails", onclick: sincronizar }),
          ]),
        ]),
        elemento("p", { id: "outlook-conexao-status", class: "flow-outlook-status", role: "status", "aria-live": "polite" }),
        elemento("div", { class: "flow-outlook-orientacao" }, [
          elemento("strong", { text: "Uso diário" }),
          elemento("ol", {}, [
            elemento("li", { text: "Mova o e-mail para a pasta GRCON Flow \\ Entrada no Outlook." }),
            elemento("li", { text: "Aguarde até 5 minutos — é a recorrência do Power Automate — e clique em Sincronizar e-mails." }),
            elemento("li", { text: "Confira os campos e registre os selecionados. Pacote marcado como Incompleto espera a sincronização do OneDrive." }),
          ]),
        ]),
        elemento("div", { id: "outlook-lista", class: "flow-outlook-lista" }),
        elemento("div", { class: "flow-outlook-rodape" }, [
          elemento("div", {}, [
            elemento("strong", { id: "outlook-selecao-resumo", text: "Selecione pelo menos um e-mail pendente." }),
            elemento("p", { id: "outlook-importacao-status", class: "flow-outlook-status", role: "status", "aria-live": "polite" }),
          ]),
          elemento("button", { id: "outlook-importar", class: "primary-button", type: "button", text: "Registrar selecionados (0)", disabled: true, onclick: importarSelecionados }),
        ]),
      ])
    );
    desenharFila();
    restaurarPasta();
  }

  root.FlowOutlookSync = Object.freeze({
    montar, normalizarMensagem, removerAvisoConfidencialidade, uuidDeterministico,
    // Expostas para teste: são as duas decisões que, erradas, fazem um anexo
    // sumir sem ninguém perceber.
    nomeDeAnexoUtil, impedimentoDoPacote,
  });
})(window);
