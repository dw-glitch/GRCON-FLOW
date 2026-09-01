/**
 * GRCON Flow — importação assistida de e-mails preparados pelo Power Automate.
 *
 * O Power Automate salva cada mensagem numa pasta sincronizada pelo OneDrive.
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
  const EXTENSOES_IGNORADAS = new Set(["json", "tmp", "ini"]);

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
    const corpo = htmlParaTexto(corpoObjeto
      ? primeiro(corpoObjeto, ["content", "Content", "body", "Body"])
      : corpoBruto || primeiro(mensagem, ["bodyPreview", "BodyPreview", "preview", "Preview"]));
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
      pedido: analise.pedido || corpo || assunto || "Mensagem recebida pelo Outlook",
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

  async function anexosDaPasta(pasta) {
    const encontrados = [];
    for await (const [nome, handle] of pasta.entries()) {
      if (!handle || handle.kind !== "file") continue;
      const extensao = nome.toLowerCase().split(".").pop();
      if ([ARQUIVO_MENSAGEM, ARQUIVO_PRONTO, ARQUIVO_IMPORTADO].includes(nome.toLowerCase())) continue;
      if (EXTENSOES_IGNORADAS.has(extensao)) continue;
      try { encontrados.push(await handle.getFile()); } catch (_) { /* arquivo ainda sincronizando */ }
    }
    encontrados.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    return encontrados;
  }

  function documentosDosAnexos(arquivos) {
    if (!Docs || typeof Docs.deArquivos !== "function") return [];
    return Docs.deArquivos(arquivos).map((item) => texto(item && (item.document || item.requested_title))).filter(Boolean);
  }

  function chaveDocumento(valor) {
    return Docs && Docs.chave ? Docs.chave(valor) : texto(valor).toUpperCase();
  }

  async function carregarPacote(nome, pasta) {
    if (!await arquivoDaPasta(pasta, ARQUIVO_PRONTO)) return null;
    const mensagem = await jsonDaPasta(pasta, ARQUIVO_MENSAGEM);
    if (!mensagem) return { nome, pasta, erro: "mensagem.json inválido ou indisponível." };
    const importado = await jsonDaPasta(pasta, ARQUIVO_IMPORTADO);
    const anexos = await anexosDaPasta(pasta);
    const dados = normalizarMensagem(mensagem, nome);
    dados.documentos = [...new Set([...dados.documentos, ...documentosDosAnexos(anexos)].map(texto).filter(Boolean))];
    return { nome, pasta, mensagem, dados, anexos, importado, selecionado: !importado, erro: "" };
  }

  async function lerFila() {
    const resultado = [];
    for await (const [nome, handle] of handleFila.entries()) {
      if (!handle || handle.kind !== "directory") continue;
      const pacote = await carregarPacote(nome, handle);
      if (pacote) resultado.push(pacote);
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
    const seletor = elemento("select", { id: idCampo(indice, "tipo"), "aria-label": "Tipo de solicitação" });
    seletor.append(elemento("option", { value: "", text: "Escolha o tipo…" }));
    tiposAtuais.filter((tipo) => tipo.active !== false).forEach((tipo) => {
      seletor.append(elemento("option", { value: tipo.code, text: tipo.label, selected: tipo.code === selecionado }));
    });
    return seletor;
  }

  function alternarPacote(indice, marcado) {
    if (!pacotes[indice] || pacotes[indice].importado || pacotes[indice].erro) return;
    pacotes[indice].selecionado = marcado;
    atualizarResumoSelecao();
  }

  function atualizarResumoSelecao() {
    const marcados = pacotes.filter((pacote) => pacote.selecionado && !pacote.importado && !pacote.erro).length;
    const botao = document.getElementById("outlook-importar");
    const resumo = document.getElementById("outlook-selecao-resumo");
    if (botao) { botao.disabled = !marcados || importando; botao.textContent = importando ? "Registrando…" : `Registrar selecionados (${marcados})`; }
    if (resumo) resumo.textContent = marcados ? `${marcados} e-mail(s) pronto(s) para revisão e registro.` : "Selecione pelo menos um e-mail pendente.";
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
      type: "checkbox", checked: pacote.selecionado, disabled: concluido,
      "aria-label": `Selecionar ${pacote.dados.assunto}`,
      onchange: (evento) => alternarPacote(indice, evento.target.checked),
    });
    const status = concluido
      ? elemento("span", { class: "flow-selo ok", text: pacote.importado.protocol || "Importado" })
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
        elemento("span", { text: "Contato" }),
        elemento("input", { id: idCampo(indice, "contato"), value: pacote.dados.remetenteEmail }),
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
        concluido && pacote.importado.imported_at
          ? elemento("span", { text: `Registrado em ${dataRecebida(pacote.importado.imported_at)}` }) : null,
      ]),
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
      atualizarConexao(`Fila conectada: ${handleFila.name} · ${pacotes.length} pacote(s)`, "ok");
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
    const handle = await pacote.pasta.getFileHandle(ARQUIVO_IMPORTADO, { create: true });
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
          origem_preenchimento: "outlook_onedrive",
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
      ...((solicitacao.anexos || []).map((anexo) => `${texto(anexo.original_name)}\u0000${Number(anexo.file_size) || 0}`)),
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

  async function importarSelecionados() {
    if (importando) return;
    const selecionados = pacotes.map((pacote, indice) => ({ pacote, indice }))
      .filter(({ pacote }) => pacote.selecionado && !(pacote.importado && pacote.importado.status === "concluido") && !pacote.erro);
    if (!selecionados.length) return;
    importando = true;
    atualizarResumoSelecao();
    const progresso = document.getElementById("outlook-importacao-status");
    const resultados = [];
    try {
      for (let posicao = 0; posicao < selecionados.length; posicao += 1) {
        const { pacote, indice } = selecionados[posicao];
        progresso.className = "flow-outlook-status carregando";
        progresso.textContent = `Registrando e-mail ${posicao + 1} de ${selecionados.length}…`;
        resultados.push(await importarPacote(pacote, indice, progresso));
      }
      const avisos = resultados.flatMap((resultado) => resultado.avisos || []);
      progresso.className = `flow-outlook-status ${avisos.length ? "atencao" : "ok"}`;
      progresso.textContent = `${resultados.length} solicitação(ões) registrada(s).${avisos.length ? ` ${avisos.length} aviso(s) para conferência.` : ""}`;
      avisar(`${resultados.length} solicitação(ões) importada(s) do Outlook.`, "ok");
      if (typeof aoRegistrarAtual === "function" && resultados.length) {
        await aoRegistrarAtual(resultados[resultados.length - 1].data);
      }
    } catch (erro) {
      progresso.className = "flow-outlook-status erro";
      progresso.textContent = erro.message || "A importação foi interrompida. Tente novamente; o protocolo já criado não será duplicado.";
      avisar(progresso.textContent, "erro");
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
            elemento("li", { text: "Mova o e-mail para GRCON Flow \\ Entrada na caixa compartilhada." }),
            elemento("li", { text: "Aguarde até 5 minutos e clique em Sincronizar e-mails." }),
            elemento("li", { text: "Confira os campos e registre os selecionados." }),
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

  root.FlowOutlookSync = Object.freeze({ montar, normalizarMensagem, uuidDeterministico });
})(window);
