/**
 * GRCON Flow — registro rápido exclusivo da equipe da Qualidade.
 *
 * Esta é uma entrada curta para pedidos que chegaram por Teams, e-mail,
 * telefone ou conversa. Ela não finge que o operador é o solicitante: o banco
 * grava separadamente quem pediu e quem lançou. O protocolo nasce antes da
 * triagem e dos anexos, preservando a criação mesmo se uma etapa posterior
 * falhar.
 */
(function (root) {
  "use strict";

  const Ui = root.FlowUi;
  const Api = root.FlowApi;
  const Docs = root.FlowDocs;
  const { elemento, avisar, texto } = Ui;

  let modal = null;
  let retornoFoco = null;
  let aoRegistrarAtual = null;
  let tiposAtuais = [];
  let arquivos = [];
  let enviando = false;
  let clientRequestId = "";

  function uuid() {
    if (root.crypto && typeof root.crypto.randomUUID === "function") return root.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (caractere) => {
      const aleatorio = Math.floor(Math.random() * 16);
      return (caractere === "x" ? aleatorio : (aleatorio & 0x3) | 0x8).toString(16);
    });
  }

  function tamanhoArquivo(bytes) {
    const valor = Math.max(0, Number(bytes) || 0);
    if (valor < 1024 * 1024) return `${Math.max(1, Math.round(valor / 1024))} KB`;
    return `${(valor / (1024 * 1024)).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
  }

  function campo(id, rotulo, entrada, { ajuda = "", largo = false, obrigatorio = false } = {}) {
    return elemento("label", { class: `flow-campo${largo ? " larga" : ""}`, for: id }, [
      elemento("span", {}, [
        rotulo,
        obrigatorio ? elemento("span", { class: "obrigatorio", text: "*", "aria-hidden": "true" }) : null,
      ]),
      ajuda ? elemento("small", { text: ajuda }) : null,
      entrada,
    ]);
  }

  function tipoSelecionado() {
    const codigo = texto(document.getElementById("rapido-tipo")?.value);
    return tiposAtuais.find((tipo) => tipo.code === codigo) || null;
  }

  function totalBytes() {
    return arquivos.reduce((total, arquivo) => total + (Number(arquivo.size) || 0), 0);
  }

  function desenharArquivos() {
    const destino = document.getElementById("rapido-arquivos-lista");
    const resumo = document.getElementById("rapido-arquivos-resumo");
    if (!destino || !resumo) return;
    resumo.textContent = arquivos.length
      ? `${arquivos.length} arquivo(s) · ${tamanhoArquivo(totalBytes())}`
      : `Opcional · até ${Api.anexos.maximo} arquivos e ${Api.anexos.maximoTotalMb} MB no total`;
    destino.replaceChildren(...arquivos.map((arquivo, indice) => elemento("div", {
      class: "flow-registro-rapido-arquivo",
    }, [
      elemento("span", { text: `${arquivo.name} · ${tamanhoArquivo(arquivo.size)}` }),
      elemento("button", {
        class: "text-button danger", type: "button", text: "Remover",
        "aria-label": `Remover ${arquivo.name}`,
        onclick: () => { arquivos.splice(indice, 1); desenharArquivos(); },
      }),
    ])));
  }

  function receberArquivos(lista) {
    const novos = Array.from(lista || []);
    if (!novos.length) return;
    const existentes = new Set(arquivos.map((arquivo) => `${arquivo.name}\u0000${arquivo.size}\u0000${arquivo.lastModified || 0}`));
    const erros = [];
    novos.forEach((arquivo) => {
      const chave = `${arquivo.name}\u0000${arquivo.size}\u0000${arquivo.lastModified || 0}`;
      const erro = Api.anexos.validar(arquivo);
      if (erro) erros.push(erro);
      else if (existentes.has(chave)) erros.push(`“${arquivo.name}” já foi incluído.`);
      else if (arquivos.length >= Api.anexos.maximo) erros.push(`O limite é de ${Api.anexos.maximo} anexos.`);
      else if (totalBytes() + Number(arquivo.size) > Api.anexos.limiteTotalBytes) {
        erros.push(`A soma dos anexos pode ter no máximo ${Api.anexos.maximoTotalMb} MB.`);
      } else {
        existentes.add(chave);
        arquivos.push(arquivo);
      }
    });
    if (erros.length) avisar(erros.join(" "), "erro");
    desenharArquivos();
  }

  function atualizarDocumentos() {
    const tipo = tipoSelecionado();
    const bloco = document.getElementById("rapido-documentos-bloco");
    if (!bloco) return;
    const documental = Boolean(tipo && (tipo.allows_documents || tipo.requires_document));
    bloco.hidden = !documental;
    const entrada = document.getElementById("rapido-documentos");
    if (entrada) entrada.required = Boolean(tipo && tipo.requires_document);
  }

  function fechar() {
    if (!modal || enviando) return;
    modal.remove();
    modal = null;
    const foco = retornoFoco;
    retornoFoco = null;
    if (foco && typeof foco.focus === "function") foco.focus();
  }

  function chaveDocumento(valor) {
    return Docs.chave ? Docs.chave(valor) : texto(valor).toUpperCase();
  }

  function itemDoAnexo(arquivo, itensCriados) {
    const candidatos = Docs.deArquivos([arquivo]);
    const encontrado = candidatos.find((item) => item.document);
    if (encontrado) {
      const chave = chaveDocumento(encontrado.document);
      const correspondente = itensCriados.find((item) => chaveDocumento(item.document) === chave);
      if (correspondente && correspondente.requires_pdf_excel_pair) return correspondente.id;
    }
    const pares = itensCriados.filter((item) => item.requires_pdf_excel_pair);
    return pares.length === 1 ? pares[0].id : null;
  }

  async function enviarArquivos(requestId, itensCriados, progresso) {
    const falhas = [];
    for (let indice = 0; indice < arquivos.length; indice += 1) {
      const arquivo = arquivos[indice];
      progresso.textContent = `Enviando anexo ${indice + 1} de ${arquivos.length}: ${arquivo.name}`;
      const itemId = itemDoAnexo(arquivo, itensCriados);
      const retorno = await Api.anexos.enviar(requestId, arquivo, itemId, ({ percentual }) => {
        progresso.textContent = `Enviando anexo ${indice + 1} de ${arquivos.length}: ${arquivo.name} · ${percentual}%`;
      });
      if (retorno.error) falhas.push(`${arquivo.name}: ${retorno.error}`);
    }
    return falhas;
  }

  function validar() {
    const tipo = tipoSelecionado();
    const nome = texto(document.getElementById("rapido-solicitante")?.value);
    const pedido = texto(document.getElementById("rapido-pedido")?.value);
    const bruto = texto(document.getElementById("rapido-documentos")?.value);
    if (!tipo) return "Escolha o tipo de solicitação.";
    if (!nome) return "Informe o nome do solicitante.";
    if (!pedido) return "Resuma o que foi solicitado.";
    if (tipo.requires_document && !bruto) return "Informe pelo menos um documento ou título.";
    return null;
  }

  async function registrar() {
    if (enviando) return;
    if (!Api.auth.ehEquipe()) {
      avisar("Somente a equipe da Qualidade pode usar o registro rápido.", "erro");
      fechar();
      return;
    }
    const pendencia = validar();
    if (pendencia) { avisar(pendencia, "erro"); return; }

    const tipo = tipoSelecionado();
    const botao = document.getElementById("rapido-registrar");
    const progresso = document.getElementById("rapido-progresso");
    enviando = true;
    botao.disabled = true;
    botao.textContent = "Registrando…";
    progresso.className = "flow-registro-rapido-progresso";
    progresso.textContent = "Criando o protocolo…";
    if (!clientRequestId) clientRequestId = uuid();

    const brutoDocumentos = texto(document.getElementById("rapido-documentos")?.value);
    const itens = (tipo.allows_documents || tipo.requires_document) && brutoDocumentos
      ? Docs.semRepetidos(Docs.daListaFlexivel(brutoDocumentos)).itens
      : [];
    const pedido = texto(document.getElementById("rapido-pedido")?.value);
    const { data, error } = await Api.solicitacoes.criarRapida({
      tipo: tipo.code,
      nome: document.getElementById("rapido-solicitante").value,
      area: document.getElementById("rapido-area").value,
      contato: document.getElementById("rapido-contato").value,
      resumo: pedido.slice(0, 300),
      descricao: pedido,
      formulario: {
        pedido_resumido: pedido,
        origem_registro: "Registro rápido pela Qualidade",
        _client_request_id: clientRequestId,
      },
      itens,
    });

    if (error) {
      enviando = false;
      botao.disabled = false;
      botao.textContent = "Registrar";
      progresso.className = "flow-registro-rapido-progresso erro";
      progresso.textContent = error;
      return;
    }

    const itensCriados = Array.isArray(data.request_items) ? data.request_items : [];
    const falhas = arquivos.length ? await enviarArquivos(data.id, itensCriados, progresso) : [];
    progresso.textContent = "Conferindo os documentos nas LDs…";
    const triagem = await Api.triagem.solicitacao(data.id, ({ atual, total }) => {
      progresso.textContent = `Conferindo os documentos nas LDs: ${atual} de ${total}…`;
    });

    enviando = false;
    progresso.className = `flow-registro-rapido-progresso ${falhas.length || triagem.error ? "erro" : "ok"}`;
    progresso.textContent = falhas.length || triagem.error
      ? `${data.protocol} foi registrado. ${falhas.length ? `${falhas.length} anexo(s) não foram enviados. ` : ""}${triagem.error ? "A triagem ficará pendente no painel." : ""}`
      : `${data.protocol} registrado com sucesso.`;
    const abrirSolicitacao = elemento("button", {
      id: "rapido-abrir-solicitacao", class: "primary-button", type: "button", text: "Abrir solicitação",
      onclick: async () => {
      const callback = aoRegistrarAtual;
      fechar();
      if (typeof callback === "function") await callback(data);
      },
    });
    botao.replaceWith(abrirSolicitacao);
    const cancelar = document.getElementById("rapido-cancelar");
    if (cancelar) cancelar.textContent = "Fechar";
    avisar(`${data.protocol} registrado pela Qualidade.`, "ok");
  }

  function abrir({ tipos = [], aoRegistrar = null } = {}) {
    if (!Api.auth.ehEquipe()) {
      avisar("Somente a equipe da Qualidade pode usar o registro rápido.", "erro");
      return;
    }
    if (modal) return;
    tiposAtuais = (tipos || []).filter((tipo) => tipo.active !== false);
    aoRegistrarAtual = aoRegistrar;
    arquivos = [];
    enviando = false;
    clientRequestId = "";
    retornoFoco = document.activeElement;

    const selecaoTipo = elemento("select", { id: "rapido-tipo", required: true });
    selecaoTipo.append(elemento("option", { value: "", text: "Selecione…" }));
    tiposAtuais.forEach((tipo) => selecaoTipo.append(elemento("option", { value: tipo.code, text: tipo.label })));
    selecaoTipo.addEventListener("change", atualizarDocumentos);

    const solicitante = elemento("input", {
      id: "rapido-solicitante", type: "text", required: true,
      placeholder: "Nome de quem fez o pedido", autocomplete: "off",
    });
    const area = elemento("input", { id: "rapido-area", type: "text", placeholder: "Área ou setor", autocomplete: "off" });
    const contato = elemento("input", { id: "rapido-contato", type: "text", placeholder: "E-mail ou ramal", autocomplete: "off" });
    const pedido = elemento("textarea", {
      id: "rapido-pedido", class: "flow-registro-rapido-resumo", rows: "4", required: true,
      placeholder: "Cole a mensagem recebida ou escreva um resumo objetivo.",
    });
    const documentos = elemento("textarea", {
      id: "rapido-documentos", class: "flow-registro-rapido-documentos", rows: "5",
      placeholder: "Um código ou título por linha",
    });
    const entradaArquivos = elemento("input", {
      id: "rapido-arquivos", type: "file", multiple: true, accept: Api.anexos.accept,
    });
    entradaArquivos.addEventListener("change", () => {
      receberArquivos(entradaArquivos.files);
      entradaArquivos.value = "";
    });

    const botaoFechar = elemento("button", {
      id: "rapido-cancelar", class: "secondary-button", type: "button", text: "Cancelar", onclick: fechar,
    });
    const botaoRegistrar = elemento("button", {
      id: "rapido-registrar", class: "primary-button", type: "button", text: "Registrar", onclick: registrar,
    });

    modal = elemento("div", {
      class: "flow-modal flow-registro-rapido", role: "dialog", "aria-modal": "true",
      "aria-labelledby": "rapido-titulo",
    }, [
      elemento("section", { class: "flow-modal-painel" }, [
        elemento("header", { class: "flow-modal-head" }, [
          elemento("div", { style: "flex:1" }, [
            elemento("h2", { id: "rapido-titulo", text: "Registrar solicitação" }),
            elemento("p", { text: "Cadastro rápido em nome do solicitante, com autoria preservada no histórico." }),
          ]),
          elemento("button", { class: "text-button", type: "button", text: "Fechar", onclick: fechar }),
        ]),
        elemento("div", { class: "flow-modal-corpo" }, [
          elemento("div", { class: "flow-grid" }, [
            campo("rapido-tipo", "Tipo", selecaoTipo, { obrigatorio: true }),
            campo("rapido-solicitante", "Solicitante", solicitante, { obrigatorio: true }),
            campo("rapido-area", "Área / setor", area),
            campo("rapido-contato", "Contato", contato),
          ]),
          campo("rapido-pedido", "Pedido", pedido, {
            largo: true, obrigatorio: true,
            ajuda: "Pode colar diretamente a mensagem recebida por e-mail ou Teams.",
          }),
          elemento("div", { id: "rapido-documentos-bloco", hidden: true }, [
            campo("rapido-documentos", "Documentos ou títulos", documentos, {
              largo: true, ajuda: "Um por linha. Código não é obrigatório quando a pessoa informou somente o título.",
            }),
          ]),
          campo("rapido-arquivos", "Anexos", entradaArquivos, {
            largo: true, ajuda: `Opcional · ${Api.anexos.formatos}`,
          }),
          elemento("p", { id: "rapido-arquivos-resumo", class: "flow-registro-rapido-progresso" }),
          elemento("div", { id: "rapido-arquivos-lista", class: "flow-registro-rapido-arquivos" }),
          elemento("p", {
            id: "rapido-progresso", class: "flow-registro-rapido-progresso", role: "status", "aria-live": "polite",
          }),
        ]),
        elemento("footer", { class: "flow-modal-acoes" }, [botaoFechar, botaoRegistrar]),
      ]),
    ]);

    modal.addEventListener("click", (evento) => { if (evento.target === modal) fechar(); });
    modal.addEventListener("keydown", (evento) => {
      if (evento.key === "Escape") { evento.preventDefault(); fechar(); }
      if (evento.key !== "Tab") return;
      const focaveis = [...modal.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]'
      )].filter((node) => !node.hidden && node.offsetParent !== null);
      if (!focaveis.length) return;
      const primeiro = focaveis[0];
      const ultimo = focaveis[focaveis.length - 1];
      if (evento.shiftKey && document.activeElement === primeiro) {
        evento.preventDefault(); ultimo.focus();
      } else if (!evento.shiftKey && document.activeElement === ultimo) {
        evento.preventDefault(); primeiro.focus();
      }
    });
    document.body.append(modal);
    desenharArquivos();
    solicitante.focus();
  }

  root.FlowRegistroRapido = Object.freeze({ abrir });
})(window);
