/**
 * GRCON Flow — painel operacional.
 *
 * A tela de quem recebe, tria, distribui, executa e conclui.
 *
 * O painel não é o mesmo para todo tipo de solicitação: as colunas dos itens
 * vêm de `panel_columns` do tipo. Uma Postagem no SIGEM quer ver alocação e
 * status SIGEM; um "Localizar código pelo título" quer ver o título informado
 * e os candidatos. Mostrar as mesmas colunas para os dois obrigaria a pessoa a
 * ler a tela inteira para achar a informação que importa.
 */
(function (root) {
  "use strict";

  const Ui = root.FlowUi;
  const { elemento, avisar, texto, seloClassificacao, seloStatus, seloPrazo, data: fmtData, dataHora } = Ui;
  const Api = root.FlowApi;
  const app = document.getElementById("app");
  const COLUNAS_LISTA = (root.FlowExport && root.FlowExport.COLUNAS_PAINEL
    ? root.FlowExport.COLUNAS_PAINEL.map((coluna) =>
      coluna.header.charAt(0) + coluna.header.slice(1).toLocaleLowerCase("pt-BR"))
    : ["Protocolo", "Tipo", "Solicitante", "Recebida", "Responsável", "Progresso", "Status", "Prazo"]);
  const INTERVALO_NOTIFICACOES_MS = 60000;
  const INTERVALO_ARMAZENAMENTO_MS = 30000;
  let pararObservacaoArmazenamento = null;
  let timerArmazenamento = null;

  const estado = {
    aba: "solicitacoes",
    tipos: [],
    tiposPorCodigo: new Map(),
    solicitacoes: [],
    filtros: { busca: "", tipo: "", status: "", classificacao: "", indicador: "" },
    selecionadas: new Set(),
    aberta: null,
    carregando: false,
    notificacoes: [],
    notificacoesTotal: 0,
    notificacoesAbertas: false,
    notificacoesMarcando: false,
    notificacoesCarregando: false,
    notificacaoExcluindoId: "",
    notificacoesExcluindoTodas: false,
    notificacoesErro: "",
  };

  function tamanhoArquivo(bytes) {
    const tamanho = Number(bytes) || 0;
    if (!tamanho) return "tamanho não informado";
    if (tamanho < 1024 * 1024) return `${Math.max(1, Math.round(tamanho / 1024))} KB`;
    return `${(tamanho / (1024 * 1024)).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
  }

  function tamanhoArmazenamento(bytes) {
    // O Dashboard do Supabase apresenta capacidade em unidades decimais
    // (1 MB = 1.000.000 bytes; 1 GB = 1.000 MB). Usar a mesma convenção evita
    // que 63 milhões de bytes apareçam como ~60 MiB no Flow.
    const tamanho = Math.max(0, Number(bytes) || 0);
    if (tamanho < 1000) return `${tamanho.toLocaleString("pt-BR")} B`;
    if (tamanho < 1000 * 1000) {
      return `${(tamanho / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} KB`;
    }
    if (tamanho < 1000 * 1000 * 1000) {
      return `${(tamanho / (1000 * 1000)).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
    }
    return `${(tamanho / (1000 * 1000 * 1000)).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} GB`;
  }

  // ---------------------------------------------------------------------------
  // Colunas dos itens — é aqui que o painel muda conforme o pedido
  // ---------------------------------------------------------------------------
  const ETAPAS_INTERNAS = Object.freeze({
    pendente: "Pendente", em_andamento: "Em andamento", concluido: "Concluído", nao_aplicavel: "Não aplicável",
  });
  const PROXIMAS_ACOES = Object.freeze({
    IDENTIFICAR_CODIGO: "Identificar código", INCLUIR_LD: "Incluir na LD",
    ANEXAR_PDF_EXCEL: "Receber PDF + Excel (N-1710)", ALOCAR: "Fazer GRDT / alocação",
    POSTAR_SIGEM: "Postar no SIGEM", CONCLUIDO: "Concluído",
  });
  const etapaInterna = (valor) => elemento("span", { class: `flow-selo ${valor === "concluido" ? "ok" : valor === "em_andamento" ? "validar" : "acao"}`, text: ETAPAS_INTERNAS[valor] || texto(valor) || "—" });

  const COLUNAS = {
    document: {
      rotulo: "Documento",
      celula: (item) => item.document
        ? elemento("code", { text: item.document })
        : elemento("span", { style: "color:var(--text-3);font-style:italic", text: "sem código" }),
    },
    requested_title: { rotulo: "Título informado", celula: (item) => elemento("span", { text: texto(item.requested_title) || "—" }) },
    official_title: { rotulo: "Título na LD", celula: (item) => elemento("span", { text: texto(item.official_title) || "—" }) },
    reference: { rotulo: "Referência", celula: (item) => elemento("span", { text: texto(item.reference) || "—" }) },
    allocation: {
      rotulo: "Alocação",
      celula: (item) => {
        if (texto(item.allocation)) return elemento("code", { text: item.allocation });
        if (item.classification === "ACAO_NECESSARIA") {
          return elemento("span", { class: "flow-selo acao", text: "Sem alocação identificada" });
        }
        return elemento("span", { style: "color:var(--text-3)", text: "—" });
      },
    },
    allocation_status: { rotulo: "Situação da alocação", celula: (item) => elemento("span", { text: texto(item.allocation_status) || "—" }) },
    sigem_status: { rotulo: "SIGEM", celula: (item) => elemento("span", { text: texto(item.sigem_status) || "—" }) },
    revision: { rotulo: "Rev.", celula: (item) => elemento("span", { text: texto(item.revision) || "—" }) },
    ld_name: { rotulo: "LD", celula: (item) => elemento("span", { text: texto(item.ld_name) || "—" }) },
    discipline: { rotulo: "Disciplina", celula: (item) => elemento("span", { text: texto(item.discipline) || "—" }) },
    last_grdt: { rotulo: "Última GRDT", celula: (item) => elemento("span", { text: texto(item.last_grdt) || "—" }) },
    answer: { rotulo: "Resposta", celula: (item) => elemento("span", { text: texto(item.answer) || "—" }) },
    internal_next_action: { rotulo: "Próxima ação", celula: (item) => elemento("strong", { text: PROXIMAS_ACOES[item.internal_next_action] || texto(item.internal_next_action) || "—" }) },
    code_stage: { rotulo: "Código", celula: (item) => etapaInterna(item.code_stage) },
    ld_stage: { rotulo: "LD", celula: (item) => etapaInterna(item.ld_stage) },
    allocation_stage: { rotulo: "Alocação", celula: (item) => etapaInterna(item.allocation_stage) },
    sigem_stage: { rotulo: "Postagem SIGEM", celula: (item) => etapaInterna(item.sigem_stage) },
    n1710_files: {
      rotulo: "Arquivos LI/MC",
      celula: (item) => {
        if (!item.requires_pdf_excel_pair) return elemento("span", { style: "color:var(--text-3)", text: "—" });
        const completo = item.pdf_attachment_ready && item.excel_attachment_ready;
        return elemento("span", { class: `flow-selo ${completo ? "ok" : "acao"}`, text:
          completo ? "PDF + Excel ✓"
            : `Falta ${[!item.pdf_attachment_ready ? "PDF" : "", !item.excel_attachment_ready ? "Excel" : ""].filter(Boolean).join(" + ")}`
        });
      },
    },
    classification: { rotulo: "Classificação", celula: (item, tipo) => seloClassificacao(item.classification, tipo && tipo.not_found_is_expected) },
  };

  function colunasDoTipo(codigo) {
    const tipo = estado.tiposPorCodigo.get(codigo);
    const chaves = (tipo && Array.isArray(tipo.panel_columns) && tipo.panel_columns.length)
      ? tipo.panel_columns
      : ["document", "official_title", "allocation", "classification"];
    return chaves.map((chave) => ({ chave, ...COLUNAS[chave] })).filter((coluna) => coluna.rotulo);
  }

  // ---------------------------------------------------------------------------
  // Indicadores
  // ---------------------------------------------------------------------------
  const INDICADORES = [
    { chave: "emAberto", rotulo: "Em aberto", classe: "", filtro: { abertas: true } },
    { chave: "hojeRecebidas", rotulo: "Recebidas hoje", classe: "", filtro: { hoje: true } },
    { chave: "execucao", rotulo: "Em execução", classe: "", filtro: { status: "em_execucao" } },
    { chave: "validacao", rotulo: "Aguardando validação", classe: "atencao", filtro: { status: "aguardando_validacao" } },
    { chave: "atrasadas", rotulo: "Atrasadas", classe: "alerta", filtro: { atrasadas: true } },
    { chave: "semResponsavel", rotulo: "Sem responsável", classe: "atencao", filtro: { semResponsavel: true } },
    { chave: "pendenteId", rotulo: "Identificação pendente", classe: "atencao", filtro: { classificacao: "IDENTIFICACAO_PENDENTE" } },
    { chave: "naoLocalizados", rotulo: "Não localizados", classe: "alerta", filtro: { classificacao: "NAO_LOCALIZADO" } },
    { chave: "semAlocacao", rotulo: "Sem alocação", classe: "alerta", filtro: { classificacao: "ACAO_NECESSARIA" } },
    { chave: "concluidas", rotulo: "Concluídas", classe: "ok", filtro: { status: "concluido" } },
  ];

  async function montarIndicadores(destino) {
    const numeros = await Api.solicitacoes.indicadores();
    destino.replaceChildren(...INDICADORES.map((indicador) => elemento("button", {
      class: `flow-indicador ${indicador.classe}`,
      type: "button",
      "aria-pressed": estado.filtros.indicador === indicador.chave ? "true" : "false",
      onclick: () => aplicarIndicador(indicador),
    }, [
      elemento("strong", { text: String(numeros[indicador.chave] ?? 0) }),
      elemento("span", { text: indicador.rotulo }),
    ])));
  }

  async function montarArmazenamento(destino, silencioso = false) {
    if (!Api.auth.ehProprietario() || !destino || !destino.isConnected) return;
    if (!silencioso) {
      destino.className = "flow-armazenamento carregando";
      destino.replaceChildren(elemento("span", { text: "Consultando armazenamento…" }));
    }
    const { data, error } = await Api.armazenamento.resumo();
    if (!destino.isConnected) return;
    if (error) {
      if (silencioso) return;
      destino.className = "flow-armazenamento indisponivel";
      destino.replaceChildren(
        elemento("strong", { text: "Armazenamento" }),
        elemento("span", { text: "Não foi possível consultar agora." })
      );
      return;
    }

    const resumo = Array.isArray(data) ? data[0] : data;
    const usados = Number(resumo && resumo.total_bytes) || 0;
    const bancoBytes = Number(resumo && resumo.database_bytes) || 0;
    const anexosBytes = Number(resumo && resumo.attachment_bytes) || 0;
    const anexosArquivos = Number(resumo && resumo.attachment_files) || 0;
    const ldBytes = Number(resumo && resumo.ld_bytes) || 0;
    const normBytes = Number(resumo && resumo.norm_bytes) || 0;
    const cota = (Number(Api.config.storageQuotaMb) || 1000) * 1000 * 1000;
    const cotaBanco = (Number(Api.config.databaseQuotaMb) || 500) * 1000 * 1000;
    const percentualReal = cota ? (usados / cota) * 100 : 0;
    const percentualBanco = cotaBanco ? (bancoBytes / cotaBanco) * 100 : 0;
    const percentual = Math.min(100, Math.max(0, percentualReal));
    const maiorPercentual = Math.max(percentualReal, percentualBanco);
    const classe = maiorPercentual >= 85 ? "critico" : maiorPercentual >= 70 ? "atencao" : "ok";
    const medido = resumo && resumo.measured_at ? new Date(resumo.measured_at) : new Date();
    const horario = Number.isNaN(medido.getTime()) ? "agora" : medido.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    destino.className = `flow-armazenamento ${classe}`;
    destino.replaceChildren(
      elemento("div", { class: "flow-armazenamento-texto" }, [
        elemento("span", { text: "Uso atual dos arquivos · GRCON Flow" }),
        elemento("strong", { text: `${tamanhoArmazenamento(usados)} de ${tamanhoArmazenamento(cota)}` }),
      ]),
      elemento("div", {
        class: "flow-armazenamento-barra", role: "progressbar",
        "aria-label": "Storage de arquivos utilizado",
        "aria-valuemin": "0", "aria-valuemax": "100",
        "aria-valuenow": String(Math.round(percentual)),
      }, [elemento("i", { style: `width:${percentual}%` })]),
      elemento("span", {
        class: "flow-armazenamento-detalhe",
        text: `Banco atual: ${tamanhoArmazenamento(bancoBytes)} de ${tamanhoArmazenamento(cotaBanco)} · Anexos: ${anexosArquivos.toLocaleString("pt-BR")} (${tamanhoArmazenamento(anexosBytes)}) · LDs: ${tamanhoArmazenamento(ldBytes)} · Normas: ${tamanhoArmazenamento(normBytes)} · medido ${horario} · O resumo do Supabase é média do ciclo e pode ter defasagem.`,
      })
    );
  }

  function pararAtualizacaoArmazenamento() {
    if (timerArmazenamento) root.clearInterval(timerArmazenamento);
    timerArmazenamento = null;
    if (typeof pararObservacaoArmazenamento === "function") pararObservacaoArmazenamento();
    pararObservacaoArmazenamento = null;
  }

  function iniciarAtualizacaoArmazenamento() {
    pararAtualizacaoArmazenamento();
    if (!Api.auth.ehProprietario()) return;
    const atualizar = () => montarArmazenamento(document.getElementById("painel-armazenamento"), true);
    pararObservacaoArmazenamento = Api.armazenamento.observar(atualizar);
    timerArmazenamento = root.setInterval(atualizar, INTERVALO_ARMAZENAMENTO_MS);
  }

  function aplicarIndicador(indicador) {
    const jaAtivo = estado.filtros.indicador === indicador.chave;
    estado.filtros = { busca: estado.filtros.busca, tipo: estado.filtros.tipo, status: "", classificacao: "", indicador: "" };
    if (!jaAtivo) {
      estado.filtros.indicador = indicador.chave;
      Object.assign(estado.filtros, indicador.filtro);
    }
    carregarSolicitacoes();
    renderAba();
  }

  // ---------------------------------------------------------------------------
  // Lista de solicitações
  // ---------------------------------------------------------------------------
  async function carregarSolicitacoes() {
    const corpo = document.getElementById("painel-tabela");
    if (corpo) Ui.carregando(corpo);
    estado.carregando = true;

    const filtros = { limite: 300 };
    const f = estado.filtros;
    if (f.busca) filtros.busca = f.busca;
    if (f.tipo) filtros.tipo = f.tipo;
    if (f.status) filtros.status = f.status;
    if (f.abertas) filtros.abertas = true;
    if (f.hoje) filtros.de = `${new Date().toISOString().slice(0, 10)}T00:00:00`;

    const { data, error } = await Api.solicitacoes.listar(filtros);
    estado.carregando = false;
    if (error) { avisar(error, "erro"); estado.solicitacoes = []; }
    else estado.solicitacoes = data || [];

    // Atrasadas e "sem responsável" são recortes da lista já carregada: são
    // perguntas sobre o prazo e sobre a atribuição, não sobre outro conjunto.
    const hoje = new Date().toISOString().slice(0, 10);
    if (f.atrasadas) {
      estado.solicitacoes = estado.solicitacoes.filter((s) =>
        s.due_at && s.due_at < hoje && !["concluido", "cancelado"].includes(s.status));
    }
    if (f.semResponsavel) {
      estado.solicitacoes = estado.solicitacoes.filter((s) =>
        !texto(s.owner_name) && !["concluido", "cancelado"].includes(s.status));
    }
    if (f.classificacao) {
      // Recorte por classificação exige olhar os itens: a classificação vive
      // neles, não na solicitação.
      const { data: itens } = await Api.itens.listar({ classificacao: f.classificacao, limite: 500 });
      const protocolos = new Set((itens || []).map((item) => item.solicitacao && item.solicitacao.protocol));
      estado.solicitacoes = estado.solicitacoes.filter((s) => protocolos.has(s.protocol));
    }

    desenharTabela();
  }

  function desenharTabela() {
    const destino = document.getElementById("painel-tabela");
    if (!destino) return;
    if (!estado.solicitacoes.length) {
      Ui.vazio(destino, "Nenhuma solicitação com esses filtros",
        "Ajuste a busca ou limpe os filtros para ver tudo que está aberto.");
      return;
    }

    const cabecalho = elemento("tr", {}, [
      elemento("th", { class: "col-check" }, [
        elemento("input", {
          type: "checkbox", "aria-label": "Selecionar todas",
          onchange: (evento) => {
            estado.selecionadas = evento.target.checked
              ? new Set(estado.solicitacoes.map((s) => s.id)) : new Set();
            desenharTabela();
          },
        }),
      ]),
      ...COLUNAS_LISTA.map((rotulo) => elemento("th", { text: rotulo })),
    ]);

    const corpo = elemento("tbody");
    estado.solicitacoes.forEach((solicitacao) => {
      const fechada = ["concluido", "cancelado"].includes(solicitacao.status);
      const proporcao = solicitacao.items_total > 0
        ? Math.round((solicitacao.items_done / solicitacao.items_total) * 100) : 0;

      corpo.append(elemento("tr", { class: estado.selecionadas.has(solicitacao.id) ? "selecionada" : "" }, [
        elemento("td", {}, [
          elemento("input", {
            type: "checkbox", "aria-label": `Selecionar ${solicitacao.protocol}`,
            checked: estado.selecionadas.has(solicitacao.id) || null,
            onchange: (evento) => {
              if (evento.target.checked) estado.selecionadas.add(solicitacao.id);
              else estado.selecionadas.delete(solicitacao.id);
              desenharTabela();
            },
          }),
        ]),
        elemento("td", {}, [
          elemento("button", {
            class: "protocolo", type: "button", text: solicitacao.protocol,
            onclick: () => abrirFicha(solicitacao.id),
          }),
        ]),
        elemento("td", { text: solicitacao.type_label }),
        elemento("td", {}, [
          elemento("span", { text: solicitacao.requester_name }),
          solicitacao.requester_area
            ? elemento("em", { style: "display:block;font-style:normal;font-size:.72rem;color:var(--text-3)", text: solicitacao.requester_area })
            : null,
        ]),
        elemento("td", { text: fmtData(solicitacao.created_at) }),
        elemento("td", { text: texto(solicitacao.owner_name) || "—" }),
        elemento("td", {}, [
          elemento("div", { class: "flow-progresso" }, [
            elemento("div", { class: "flow-progresso-barra" }, [elemento("i", { style: `width:${proporcao}%` })]),
            elemento("small", { text: `${solicitacao.items_done}/${solicitacao.items_total}` }),
          ]),
        ]),
        elemento("td", {}, [seloStatus(solicitacao.status)]),
        elemento("td", {}, [seloPrazo(solicitacao.due_at, fechada)]),
      ]));
    });

    destino.replaceChildren(elemento("div", { class: "flow-tabela-wrap" }, [
      elemento("table", { class: "flow-tabela" }, [
        elemento("thead", {}, [cabecalho]), corpo,
      ]),
    ]));

    const barra = document.getElementById("painel-lote");
    if (barra) barra.hidden = estado.selecionadas.size === 0;
    const contagem = document.getElementById("painel-lote-contagem");
    if (contagem) contagem.textContent = `${estado.selecionadas.size} selecionada(s)`;
  }

  // ---------------------------------------------------------------------------
  // Ficha da solicitação
  // ---------------------------------------------------------------------------
  async function abrirFicha(id) {
    const gaveta = document.getElementById("painel-drawer");
    const corpo = document.getElementById("painel-drawer-corpo");
    const titulo = document.getElementById("painel-drawer-titulo");
    gaveta.classList.add("aberto");
    Ui.carregando(corpo);

    const { data, error } = await Api.solicitacoes.obter(id);
    if (error || !data) { Ui.vazio(corpo, "Não foi possível abrir", error || "Solicitação não encontrada."); return; }
    estado.aberta = data;
    titulo.textContent = data.protocol;
    document.getElementById("painel-drawer-sub").textContent = `${data.type_label} · ${data.requester_name}`;

    const tipo = estado.tiposPorCodigo.get(data.type_code);
    const fechada = ["concluido", "cancelado"].includes(data.status);
    const blocos = [];

    // Dados do pedido
    const dados = elemento("dl", { class: "flow-dados" });
    const dado = (rotulo, valor, node) => {
      if (!node && !texto(valor)) return;
      dados.append(elemento("div", { class: "flow-dado" }, [
        elemento("dt", { text: rotulo }),
        elemento("dd", {}, [node || texto(valor)]),
      ]));
    };
    dado("Status", null, seloStatus(data.status));
    dado("Prazo", null, seloPrazo(data.due_at, fechada));
    dado("Recebida em", dataHora(data.created_at));
    dado("Solicitante", [data.requester_name, data.requester_area].filter(Boolean).join(" · "));
    dado("Contato", data.requester_contact);
    dado("Responsável", texto(data.owner_name) || "não atribuído");
    dado("Itens", `${data.items_done} de ${data.items_total} concluído(s)`);

    // Respostas dos campos próprios do tipo — é o que aquele pedido tinha de
    // específico e não caberia numa coluna fixa.
    const formulario = data.form_data || {};
    (tipo && tipo.campos ? tipo.campos : []).forEach((campo) => {
      if (formulario[campo.field_key]) dado(campo.label, formulario[campo.field_key]);
    });
    if (formulario.observacoes) dado("Observações", formulario.observacoes);

    blocos.push(elemento("section", { class: "flow-card" }, [
      elemento("div", { class: "flow-card-head" }, [elemento("h3", { text: "Pedido" })]),
      dados,
    ]));

    // Ações da operação
    blocos.push(montarAcoes(data, fechada));

    // Itens, com as colunas do tipo
    blocos.push(await montarItens(data, tipo));

    // Anexos
    if ((data.anexos || []).length) {
      const lista = elemento("div", { class: "flow-itens" });
      data.anexos.forEach((anexo) => {
        const extensao = texto(anexo.file_name).split(".").pop().toUpperCase();
        const itemVinculado = anexo.item_id
          ? (data.itens || []).find((item) => item.id === anexo.item_id)
          : null;
        lista.append(elemento("div", { class: "flow-item" }, [
          elemento("span", { class: "flow-item-num", text: "📎" }),
          elemento("span", { class: "flow-item-corpo" }, [
            elemento("code", { text: anexo.file_name }),
            elemento("em", { text: `${extensao} · ${tamanhoArquivo(anexo.size_bytes)}${itemVinculado ? ` · vinculado a ${itemVinculado.document || `item ${itemVinculado.item_number}`}` : ""}` }),
          ]),
          elemento("button", {
            class: "text-button", type: "button", text: "Baixar",
            onclick: async (evento) => {
              const botao = evento.currentTarget;
              botao.disabled = true;
              botao.textContent = "Preparando…";
              const { data: url, error: erroDownload } = await Api.anexos.linkDownload(
                anexo.storage_path, anexo.file_name
              );
              if (erroDownload || !url) {
                avisar(erroDownload || "Não foi possível preparar o download do anexo.", "erro");
              } else {
                const link = elemento("a", { href: url, download: anexo.file_name, hidden: true });
                document.body.append(link);
                link.click();
                link.remove();
              }
              botao.disabled = false;
              botao.textContent = "Baixar";
            },
          }),
        ]));
      });
      blocos.push(elemento("section", { class: "flow-card" }, [
        elemento("div", { class: "flow-card-head" }, [elemento("h3", { text: `Anexos (${data.anexos.length})` })]),
        lista,
      ]));
    }

    blocos.push(await montarComentarios(data));
    blocos.push(await montarHistorico(data));

    corpo.replaceChildren(...blocos);
  }

  function montarAcoes(solicitacao, fechada) {
    const tipo = estado.tiposPorCodigo.get(solicitacao.type_code);
    const fluxo = (tipo && Array.isArray(tipo.workflow) && tipo.workflow.length)
      ? tipo.workflow
      : ["recebido", "em_triagem", "em_execucao", "aguardando_validacao", "concluido"];
    const opcoes = [...new Set([...fluxo, "aguardando_info", "pendente", "cancelado"])];

    const status = elemento("select", { id: "acao-status" });
    const parN1710Pendente = (solicitacao.itens || []).some((item) =>
      item.requires_pdf_excel_pair && !(item.pdf_attachment_ready && item.excel_attachment_ready));
    opcoes.forEach((valor) => {
      const node = elemento("option", { value: valor, text: Ui.rotuloStatus(valor) });
      if (valor === solicitacao.status) node.selected = true;
      if (valor === "concluido" && parN1710Pendente) {
        node.disabled = true;
        node.title = "Há LI/MC da N-1710 sem PDF + Excel.";
      }
      status.append(node);
    });

    const responsavel = elemento("input", { id: "acao-responsavel", type: "text", autocomplete: "off", placeholder: "Nome de quem executa" });
    responsavel.value = texto(solicitacao.owner_name);

    const prazo = elemento("input", { id: "acao-prazo", type: "date" });
    prazo.value = texto(solicitacao.due_at);

    const resposta = elemento("textarea", { id: "acao-resposta", rows: "3", placeholder: "Resposta ao solicitante — o que ele vai ler ao acompanhar." });
    resposta.value = texto(solicitacao.answer);

    const salvar = async () => {
      const alteracoes = [
        ["status", status.value, solicitacao.status],
        ["owner_name", responsavel.value, solicitacao.owner_name],
        ["due_at", prazo.value, solicitacao.due_at || ""],
        ["answer", resposta.value, solicitacao.answer],
      ].filter(([, novo, antigo]) => texto(novo) !== texto(antigo));

      if (!alteracoes.length) { avisar("Nada mudou."); return; }
      for (const [campo, valor] of alteracoes) {
        const { error } = await Api.solicitacoes.atualizar(solicitacao.id, campo, valor, "");
        if (error) { avisar(error, "erro"); return; }
      }
      avisar("Solicitação atualizada.", "ok");
      abrirFicha(solicitacao.id);
      carregarSolicitacoes();
      montarIndicadores(document.getElementById("painel-indicadores"));
    };

    const reprocessar = async () => {
      if (!tipo || !tipo.uses_ld) { avisar("Este tipo não usa consulta às LDs."); return; }
      avisar("Reprocessando com as LDs vigentes…");
      const { error } = await Api.triagem.solicitacao(solicitacao.id);
      if (error) { avisar(error, "erro"); return; }
      avisar("Triagem reprocessada. O resultado anterior foi preservado no histórico.", "ok");
      abrirFicha(solicitacao.id);
    };

    const excluir = async (evento) => {
      const protocolo = texto(solicitacao.protocol).toUpperCase();
      const digitado = root.prompt(
        `A exclusão é permanente e remove itens, histórico, comentários e anexos.\n\nPara continuar, digite o protocolo ${protocolo}:`,
        ""
      );
      if (digitado === null) return;
      if (texto(digitado).toUpperCase() !== protocolo) {
        avisar("Protocolo diferente. A solicitação não foi excluída.", "erro");
        return;
      }
      if (!Ui.confirmar(`Excluir permanentemente ${protocolo}? Esta ação não pode ser desfeita.`)) return;

      const botao = evento.currentTarget;
      botao.disabled = true;
      botao.textContent = "Excluindo…";
      const { error } = await Api.solicitacoes.excluir(solicitacao.id, solicitacao.anexos || []);
      if (error) {
        botao.disabled = false;
        botao.textContent = "Excluir solicitação";
        avisar(error, "erro");
        return;
      }

      estado.selecionadas.delete(solicitacao.id);
      estado.aberta = null;
      document.getElementById("painel-drawer").classList.remove("aberto");
      avisar(`${protocolo} excluída permanentemente.`, "ok");
      await carregarSolicitacoes();
      const indicadores = document.getElementById("painel-indicadores");
      if (indicadores) montarIndicadores(indicadores);
      montarArmazenamento(document.getElementById("painel-armazenamento"));
    };

    return elemento("section", { class: "flow-card" }, [
      elemento("div", { class: "flow-card-head" }, [
        elemento("h3", { text: "Operação" }),
        elemento("p", { text: "Toda alteração fica registrada no histórico, com autor e horário." }),
      ]),
      elemento("div", { class: "flow-grid" }, [
        elemento("label", { class: "flow-campo", for: "acao-status" }, [elemento("span", { text: "Status" }), status]),
        elemento("label", { class: "flow-campo", for: "acao-responsavel" }, [elemento("span", { text: "Responsável" }), responsavel]),
        elemento("label", { class: "flow-campo", for: "acao-prazo" }, [elemento("span", { text: "Prazo" }), prazo]),
        elemento("label", { class: "flow-campo larga", for: "acao-resposta" }, [
          elemento("span", {}, [
            "Resposta ao solicitante",
            tipo && tipo.answer_required ? elemento("span", { class: "obrigatorio", text: "*" }) : null,
          ]),
          resposta,
        ]),
      ]),
      elemento("div", { class: "flow-acoes", style: "margin-top:.9rem" }, [
        elemento("button", { class: "primary-button", type: "button", text: "Salvar", onclick: salvar }),
        tipo && tipo.uses_ld
          ? elemento("button", { class: "secondary-button", type: "button", text: "Reprocessar triagem", onclick: reprocessar })
          : null,
        Api.auth.ehAdmin()
          ? elemento("button", { class: "danger-button", type: "button", text: "Excluir solicitação", onclick: excluir })
          : null,
      ]),
    ]);
  }

  async function montarItens(solicitacao, tipo) {
    const colunas = colunasDoTipo(solicitacao.type_code);
    const itens = (solicitacao.itens || []).slice().sort((a, b) => a.item_number - b.item_number);

    const cabecalho = elemento("tr", {}, [
      elemento("th", { class: "col-check", text: "#" }),
      ...colunas.map((coluna) => elemento("th", { text: coluna.rotulo })),
      elemento("th", { text: "Status" }),
      elemento("th", { text: "" }),
    ]);

    const corpo = elemento("tbody");
    itens.forEach((item) => {
      corpo.append(elemento("tr", {}, [
        elemento("td", { text: String(item.item_number) }),
        ...colunas.map((coluna) => elemento("td", {}, [coluna.celula(item, tipo)])),
        elemento("td", {}, [seloStatus(item.status)]),
        elemento("td", {}, [
          elemento("button", {
            class: "text-button", type: "button", text: "Detalhes",
            onclick: () => abrirDetalheItem(item, tipo),
          }),
        ]),
      ]));
    });

    return elemento("section", { class: "flow-card" }, [
      elemento("div", { class: "flow-card-head" }, [
        elemento("h3", { text: `Itens (${itens.length})` }),
        elemento("p", { text: "Cada item tem status próprio. A solicitação avança conforme eles avançam." }),
      ]),
      elemento("div", { class: "flow-tabela-wrap" }, [
        elemento("table", { class: "flow-tabela" }, [elemento("thead", {}, [cabecalho]), corpo]),
      ]),
      elemento("div", { class: "flow-acoes", style: "margin-top:.8rem" }, [
        elemento("button", {
          class: "secondary-button compact", type: "button", text: "Concluir todos os itens",
          disabled: itens.some((item) => item.requires_pdf_excel_pair && !(item.pdf_attachment_ready && item.excel_attachment_ready)) || null,
          title: itens.some((item) => item.requires_pdf_excel_pair && !(item.pdf_attachment_ready && item.excel_attachment_ready))
            ? "Complete o PDF + Excel dos itens LI/MC antes de concluir." : "",
          onclick: async () => {
            if (!Ui.confirmar("Marcar todos os itens desta solicitação como concluídos?")) return;
            const { error } = await Api.itens.atualizar(itens.map((i) => i.id), "status", "concluido", "Concluído em lote pela ficha");
            if (error) { avisar(error, "erro"); return; }
            avisar("Itens concluídos.", "ok");
            abrirFicha(solicitacao.id);
            carregarSolicitacoes();
          },
        }),
      ]),
    ]);
  }

  /** Detalhe de um item: o que a triagem viu, e o que dá para decidir agora. */
  async function abrirDetalheItem(item, tipo) {
    const corpo = document.getElementById("painel-drawer-corpo");
    Ui.carregando(corpo, "Carregando a triagem…");

    const { data: execucoes } = await Api.itens.historicoTriagem(item.id);
    const ultima = (execucoes || [])[0];
    const resultado = ultima ? ultima.result || {} : {};
    const ocorrencias = resultado.occurrences || [];
    const candidatos = resultado.candidates || [];

    const blocos = [];
    blocos.push(elemento("div", { class: "flow-acoes" }, [
      elemento("button", {
        class: "text-button", type: "button", text: "‹ Voltar para a solicitação",
        onclick: () => abrirFicha(item.request_id),
      }),
    ]));

    blocos.push(elemento("section", { class: "flow-card" }, [
      elemento("div", { class: "flow-card-head" }, [
        elemento("h3", { text: item.document || item.requested_title || `Item ${item.item_number}` }),
        elemento("p", { text: `Item ${item.item_number} · ${Ui.rotuloStatus(item.status)}` }),
      ]),
      elemento("div", { style: "display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:.8rem" }, [
        seloClassificacao(item.classification, tipo && tipo.not_found_is_expected),
        item.needs_validation ? elemento("span", { class: "flow-selo validar", text: "Precisa de validação" }) : null,
      ]),
      elemento("div", { class: "flow-triagem" }, [
        elemento("p", { text: ultima ? ultima.summary : "Este item ainda não foi triado." }),
        item.triage_rule ? elemento("small", { text: item.triage_rule }) : null,
        item.triaged_at ? elemento("small", { text: `Triado em ${dataHora(item.triaged_at)}${ultima ? ` · execução ${ultima.run_number}` : ""}` }) : null,
      ]),
    ]));

    if (item.requires_pdf_excel_pair) {
      const completo = item.pdf_attachment_ready && item.excel_attachment_ready;
      blocos.push(elemento("div", { class: `flow-aviso ${completo ? "ok" : "atencao"}` }, [
        elemento("strong", { text: "LI/MC · N-1710 — conjunto obrigatório" }),
        elemento("p", { text: completo
          ? "PDF e Excel recebidos. O item está liberado para seguir para GRDT/alocação."
          : `Aguardando ${[!item.pdf_attachment_ready ? "PDF" : "", !item.excel_attachment_ready ? "Excel" : ""].filter(Boolean).join(" e ")}. A GRDT/postagem não pode ser concluída até receber os dois arquivos.` }),
      ]));
    }

    // Ocorrências nas LDs
    if (ocorrencias.length) {
      const lista = elemento("div", {});
      ocorrencias.forEach((ocorrencia) => {
        lista.append(elemento("div", { class: "flow-candidato" }, [
          elemento("div", {}, [
            elemento("code", { text: ocorrencia.document }),
            elemento("em", { text: [
              ocorrencia.ld_code,
              ocorrencia.sheet ? `aba ${ocorrencia.sheet}` : "",
              ocorrencia.row_number ? `linha ${ocorrencia.row_number}` : "",
              ocorrencia.revision ? `rev. ${ocorrencia.revision}` : "",
            ].filter(Boolean).join(" · ") }),
            ocorrencia.title ? elemento("em", { text: ocorrencia.title }) : null,
          ]),
          elemento("span", {}, [
            texto(ocorrencia.allocation)
              ? elemento("code", { text: ocorrencia.allocation })
              : elemento("span", { class: "flow-selo acao", text: "sem alocação" }),
          ]),
        ]));
      });
      blocos.push(elemento("section", { class: "flow-card" }, [
        elemento("div", { class: "flow-card-head" }, [
          elemento("h3", { text: `Onde foi encontrado (${ocorrencias.length})` }),
          resultado.divergent
            ? elemento("p", { text: "As ocorrências divergem. Nenhuma foi eleita automaticamente — confirme qual vale." })
            : null,
        ]),
        lista,
      ]));
    }

    // Candidatos por título — nunca preenchidos sozinhos.
    if (candidatos.length) {
      const lista = elemento("div", {});
      candidatos.forEach((candidato) => {
        lista.append(elemento("div", { class: "flow-candidato" }, [
          elemento("div", {}, [
            elemento("code", { text: candidato.document }),
            elemento("em", { text: candidato.title }),
            elemento("em", { text: `${candidato.ld_code}${candidato.allocation ? ` · ${candidato.allocation}` : ""}` }),
          ]),
          elemento("button", {
            class: "secondary-button compact", type: "button", text: "É este",
            onclick: async () => {
              if (!Ui.confirmar(`Confirmar ${candidato.document} como o código deste item?`)) return;
              const { error } = await Api.itens.atualizar([item.id], "document", candidato.document,
                "Código confirmado pelo operador a partir dos candidatos por título");
              if (error) { avisar(error, "erro"); return; }
              // Com o código confirmado, a triagem completa passa a fazer sentido.
              await Api.triagem.item(item.id);
              avisar("Código confirmado e item triado.", "ok");
              abrirFicha(item.request_id);
            },
          }),
        ]));
      });
      blocos.push(elemento("section", { class: "flow-card" }, [
        elemento("div", { class: "flow-card-head" }, [
          elemento("h3", { text: `Possíveis correspondências (${candidatos.length})` }),
          elemento("p", { text: "Encontradas pelo título. O GRCON Flow não escolhe por você: confirme qual é o documento." }),
        ]),
        lista,
      ]));
    }

    // Ações do item
    const status = elemento("select", { id: "item-status" });
    ["recebido", "em_execucao", "aguardando_validacao", "aguardando_info", "pendente", "concluido", "cancelado"]
      .forEach((valor) => {
        const node = elemento("option", { value: valor, text: Ui.rotuloStatus(valor) });
        if (valor === item.status) node.selected = true;
        status.append(node);
      });
    const responsavel = elemento("input", { id: "item-responsavel", type: "text", autocomplete: "off" });
    responsavel.value = texto(item.owner_name);
    const documento = elemento("input", { id: "item-documento", type: "text", autocomplete: "off", placeholder: "Código confirmado" });
    documento.value = texto(item.document);
    const resposta = elemento("textarea", { id: "item-resposta", rows: "2" });
    resposta.value = texto(item.answer);
    const observacoes = elemento("textarea", { id: "item-observacoes", rows: "2" });
    observacoes.value = texto(item.observations);
    const seletorEtapa = (id, valor) => {
      const select = elemento("select", { id });
      Object.entries(ETAPAS_INTERNAS).forEach(([codigo, rotulo]) => {
        const option = elemento("option", { value: codigo, text: rotulo });
        if (codigo === valor) option.selected = true;
        select.append(option);
      });
      return select;
    };
    const fluxoPostagem = tipo && tipo.code === "POSTAGEM_SIGEM";
    const codigoEtapa = seletorEtapa("item-code-stage", item.code_stage || (item.document ? "concluido" : "pendente"));
    const ldEtapa = seletorEtapa("item-ld-stage", item.ld_stage || "pendente");
    const alocEtapa = seletorEtapa("item-allocation-stage", item.allocation_stage || "pendente");
    const sigemEtapa = seletorEtapa("item-sigem-stage", item.sigem_stage || "pendente");
    const parN1710Completo = !item.requires_pdf_excel_pair || (item.pdf_attachment_ready && item.excel_attachment_ready);
    if (!parN1710Completo) {
      const concluirStatus = status.querySelector('option[value="concluido"]');
      const concluirSigem = sigemEtapa.querySelector('option[value="concluido"]');
      if (concluirStatus) concluirStatus.disabled = true;
      if (concluirSigem) concluirSigem.disabled = true;
    }

    blocos.push(elemento("section", { class: "flow-card" }, [
      elemento("div", { class: "flow-card-head" }, [elemento("h3", { text: "Tratar este item" })]),
      elemento("div", { class: "flow-grid" }, [
        elemento("label", { class: "flow-campo", for: "item-status" }, [elemento("span", { text: "Status" }), status]),
        elemento("label", { class: "flow-campo", for: "item-responsavel" }, [elemento("span", { text: "Responsável" }), responsavel]),
        elemento("label", { class: "flow-campo", for: "item-documento" }, [
          elemento("span", { text: "Código do documento" }),
          elemento("small", { text: "Se veio só o título, confirme o código aqui e reprocesse a triagem." }),
          documento,
        ]),
        fluxoPostagem ? elemento("label", { class: "flow-campo", for: "item-code-stage" }, [elemento("span", { text: "Etapa · Identificação do código" }), codigoEtapa]) : null,
        fluxoPostagem ? elemento("label", { class: "flow-campo", for: "item-ld-stage" }, [elemento("span", { text: "Etapa · Inclusão na LD" }), ldEtapa]) : null,
        fluxoPostagem ? elemento("label", { class: "flow-campo", for: "item-allocation-stage" }, [elemento("span", { text: "Etapa · Alocação" }), alocEtapa]) : null,
        fluxoPostagem ? elemento("label", { class: "flow-campo", for: "item-sigem-stage" }, [elemento("span", { text: "Etapa · Postagem no SIGEM" }), sigemEtapa]) : null,
        elemento("label", { class: "flow-campo larga", for: "item-resposta" }, [elemento("span", { text: "Resposta" }), resposta]),
        elemento("label", { class: "flow-campo larga", for: "item-observacoes" }, [elemento("span", { text: "Observações" }), observacoes]),
      ]),
      elemento("div", { class: "flow-acoes", style: "margin-top:.9rem" }, [
        elemento("button", {
          class: "primary-button", type: "button", text: "Salvar item",
          onclick: async () => {
            const alteracoes = [
              ["status", status.value, item.status],
              ["owner_name", responsavel.value, item.owner_name],
              ["document", documento.value, item.document],
              ...(fluxoPostagem ? [
                ["code_stage", codigoEtapa.value, item.code_stage],
                ["ld_stage", ldEtapa.value, item.ld_stage],
                ["allocation_stage", alocEtapa.value, item.allocation_stage],
                ["sigem_stage", sigemEtapa.value, item.sigem_stage],
              ] : []),
              ["answer", resposta.value, item.answer],
              ["observations", observacoes.value, item.observations],
            ].filter(([, novo, antigo]) => texto(novo) !== texto(antigo));
            if (!alteracoes.length) { avisar("Nada mudou."); return; }
            for (const [campo, valor] of alteracoes) {
              const { error } = await Api.itens.atualizar([item.id], campo, valor, "");
              if (error) { avisar(error, "erro"); return; }
            }
            avisar("Item atualizado.", "ok");
            abrirFicha(item.request_id);
          },
        }),
        tipo && tipo.uses_ld ? elemento("button", {
          class: "secondary-button", type: "button", text: "Reprocessar este item",
          onclick: async () => {
            const { error } = await Api.triagem.item(item.id);
            if (error) { avisar(error, "erro"); return; }
            avisar("Item triado novamente.", "ok");
            abrirFicha(item.request_id);
          },
        }) : null,
      ]),
    ]));

    // Execuções anteriores: reprocessar não apaga o que a análise anterior disse.
    if ((execucoes || []).length > 1) {
      const linha = elemento("div", { class: "flow-timeline" });
      execucoes.forEach((execucao) => {
        linha.append(elemento("div", { class: "flow-evento" }, [
          elemento("time", { text: dataHora(execucao.created_at) }),
          elemento("span", {}, [
            elemento("b", { text: `Execução ${execucao.run_number} · ` }),
            execucao.summary,
          ]),
        ]));
      });
      blocos.push(elemento("section", { class: "flow-card" }, [
        elemento("div", { class: "flow-card-head" }, [
          elemento("h3", { text: "Triagens anteriores" }),
          elemento("p", { text: "Reprocessar não apaga a análise anterior." }),
        ]),
        linha,
      ]));
    }

    corpo.replaceChildren(...blocos);
  }

  async function montarComentarios(solicitacao) {
    const { data } = await Api.comentarios.listar(solicitacao.id);
    const lista = elemento("div", { style: "display:grid;gap:.5rem" });
    (data || []).forEach((comentario) => {
      lista.append(elemento("div", { class: "flow-comentario" }, [
        elemento("header", {}, [
          elemento("span", { text: comentario.author_name || "equipe" }),
          elemento("span", { text: `${dataHora(comentario.created_at)}${comentario.internal ? " · interno" : " · visível ao solicitante"}` }),
        ]),
        elemento("p", { text: comentario.body }),
      ]));
    });
    if (!(data || []).length) {
      lista.append(elemento("p", { style: "color:var(--text-3);font-size:.84rem", text: "Nenhum comentário ainda." }));
    }

    const campo = elemento("textarea", { id: "comentario-novo", rows: "2", placeholder: "Comentário da equipe sobre esta solicitação…" });
    const interno = elemento("input", { type: "checkbox", id: "comentario-interno" });
    interno.checked = true;

    return elemento("section", { class: "flow-card" }, [
      elemento("div", { class: "flow-card-head" }, [
        elemento("h3", { text: "Comentários" }),
        elemento("p", { text: "Conversa da equipe. O que for marcado como interno o solicitante não vê." }),
      ]),
      lista,
      elemento("label", { class: "flow-campo", for: "comentario-novo", style: "margin-top:.8rem" }, [
        elemento("span", { text: "Novo comentário" }), campo,
      ]),
      elemento("div", { class: "flow-acoes" }, [
        elemento("label", { style: "display:flex;gap:.35rem;align-items:center;font-size:.8rem" }, [
          interno, "Somente para a equipe",
        ]),
        elemento("button", {
          class: "secondary-button compact", type: "button", text: "Comentar",
          onclick: async () => {
            if (!texto(campo.value)) { avisar("Escreva algo antes de comentar.", "erro"); return; }
            const { error } = await Api.comentarios.criar(solicitacao.id, campo.value, interno.checked);
            if (error) { avisar(error, "erro"); return; }
            campo.value = "";
            avisar("Comentário registrado.", "ok");
            abrirFicha(solicitacao.id);
          },
        }),
      ]),
    ]);
  }

  async function montarHistorico(solicitacao) {
    const { data } = await Api.historico.listar(solicitacao.id);
    const linha = elemento("div", { class: "flow-timeline" });
    const ACOES = {
      solicitacao_registrada: "Solicitação registrada",
      triagem_executada: "Triagem executada",
      solicitacao_alterada: "Solicitação alterada",
      item_alterado: "Item alterado",
    };
    (data || []).forEach((evento) => {
      const detalhe = evento.field
        ? `${evento.field}: “${evento.old_value || "vazio"}” → “${evento.new_value || "vazio"}”`
        : evento.note;
      linha.append(elemento("div", { class: "flow-evento" }, [
        elemento("time", { text: dataHora(evento.created_at) }),
        elemento("span", {}, [
          elemento("b", { text: `${ACOES[evento.action] || evento.action} · ` }),
          detalhe || "",
          evento.actor_name ? elemento("em", { style: "font-style:normal;color:var(--text-3)", text: ` (${evento.actor_name})` }) : null,
        ]),
      ]));
    });
    if (!(data || []).length) {
      linha.append(elemento("p", { style: "color:var(--text-3);font-size:.84rem", text: "Sem eventos registrados." }));
    }
    return elemento("section", { class: "flow-card" }, [
      elemento("div", { class: "flow-card-head" }, [
        elemento("h3", { text: "Histórico" }),
        elemento("p", { text: "Tudo o que aconteceu, com autor e horário." }),
      ]),
      linha,
    ]);
  }

  // ---------------------------------------------------------------------------
  // Exportação
  // ---------------------------------------------------------------------------
  async function exportar(escopo) {
    avisar("Montando a planilha…");
    const filtros = {};
    let descricao = "registros visíveis no painel";

    if (escopo === "selecionadas") {
      const protocolos = estado.solicitacoes
        .filter((s) => estado.selecionadas.has(s.id)).map((s) => s.protocol);
      if (!protocolos.length) { avisar("Selecione ao menos uma solicitação.", "erro"); return; }
      filtros.protocolos = protocolos;
      descricao = `${protocolos.length} solicitação(ões) selecionada(s)`;
    } else if (escopo === "filtro") {
      // Inclui busca, indicadores e recortes feitos no navegador: o arquivo
      // recebe exatamente os protocolos que a pessoa está vendo na tabela.
      filtros.protocolos = estado.solicitacoes.map((s) => s.protocol);
      if (!filtros.protocolos.length) { avisar("Não há solicitações visíveis para exportar.", "erro"); return; }
      descricao = `${filtros.protocolos.length} solicitação(ões) visível(is) no painel`;
    }

    const { data, error } = await Api.exportacao.linhas(filtros);
    if (error) { avisar(error, "erro"); return; }
    try {
      const total = await root.FlowExport.gerar(data || [], { descricaoFiltro: descricao });
      avisar(`Planilha gerada com ${total} linha(s).`, "ok");
    } catch (erro) {
      avisar(erro.message || "Não foi possível gerar a planilha.", "erro");
    }
  }

  // ---------------------------------------------------------------------------
  // Estrutura da página
  // ---------------------------------------------------------------------------
  function montarFiltros() {
    const busca = elemento("input", { id: "filtro-busca", type: "search", placeholder: "Protocolo, solicitante, resumo…" });
    busca.value = estado.filtros.busca;
    let timer;
    busca.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => { estado.filtros.busca = busca.value; carregarSolicitacoes(); }, 350);
    });

    const tipo = elemento("select", { id: "filtro-tipo" });
    tipo.append(elemento("option", { value: "", text: "Todos os tipos" }));
    estado.tipos.forEach((item) => {
      const node = elemento("option", { value: item.code, text: item.label });
      if (item.code === estado.filtros.tipo) node.selected = true;
      tipo.append(node);
    });
    tipo.addEventListener("change", () => { estado.filtros.tipo = tipo.value; carregarSolicitacoes(); });

    const status = elemento("select", { id: "filtro-status" });
    status.append(elemento("option", { value: "", text: "Todos os status" }));
    Object.entries(Ui.STATUS).forEach(([valor, rotulo]) => {
      const node = elemento("option", { value: valor, text: rotulo });
      if (valor === estado.filtros.status) node.selected = true;
      status.append(node);
    });
    status.addEventListener("change", () => {
      estado.filtros.status = status.value;
      estado.filtros.indicador = "";
      carregarSolicitacoes();
    });

    return elemento("div", { class: "flow-filtros" }, [
      elemento("label", { class: "flow-campo busca", for: "filtro-busca" }, [elemento("span", { text: "Buscar" }), busca]),
      elemento("label", { class: "flow-campo", for: "filtro-tipo" }, [elemento("span", { text: "Tipo" }), tipo]),
      elemento("label", { class: "flow-campo", for: "filtro-status" }, [elemento("span", { text: "Status" }), status]),
      elemento("button", {
        class: "text-button", type: "button", text: "Limpar filtros",
        onclick: () => {
          estado.filtros = { busca: "", tipo: "", status: "", classificacao: "", indicador: "" };
          renderAba();
          carregarSolicitacoes();
          montarIndicadores(document.getElementById("painel-indicadores"));
        },
      }),
      elemento("span", { style: "flex:1" }),
      elemento("button", { class: "secondary-button compact", type: "button", text: "Exportar painel", onclick: () => exportar("filtro") }),
      elemento("button", { class: "text-button", type: "button", text: "Só selecionadas", onclick: () => exportar("selecionadas") }),
    ]);
  }

  function montarLote() {
    const status = elemento("select", { id: "lote-status" });
    status.append(elemento("option", { value: "", text: "—" }));
    Object.entries(Ui.STATUS).forEach(([valor, rotulo]) => status.append(elemento("option", { value: valor, text: rotulo })));

    const responsavel = elemento("input", { id: "lote-responsavel", type: "text", placeholder: "Nome", autocomplete: "off" });

    const aplicar = async () => {
      const ids = [...estado.selecionadas];
      if (!ids.length) return;
      const tarefas = [];
      if (status.value) tarefas.push(["status", status.value]);
      if (texto(responsavel.value)) tarefas.push(["owner_name", responsavel.value]);
      if (!tarefas.length) { avisar("Escolha o que aplicar.", "erro"); return; }
      for (const id of ids) {
        for (const [campo, valor] of tarefas) {
          const { error } = await Api.solicitacoes.atualizar(id, campo, valor, "Alteração em lote pelo painel");
          if (error) { avisar(error, "erro"); return; }
        }
      }
      avisar(`${ids.length} solicitação(ões) atualizada(s).`, "ok");
      estado.selecionadas = new Set();
      status.value = ""; responsavel.value = "";
      carregarSolicitacoes();
      montarIndicadores(document.getElementById("painel-indicadores"));
    };

    return elemento("div", { class: "flow-lote", id: "painel-lote", hidden: true }, [
      elemento("strong", { id: "painel-lote-contagem", text: "0 selecionada(s)" }),
      elemento("label", { class: "flow-campo", for: "lote-status" }, [elemento("span", { text: "Novo status" }), status]),
      elemento("label", { class: "flow-campo", for: "lote-responsavel" }, [elemento("span", { text: "Responsável" }), responsavel]),
      elemento("button", { class: "secondary-button compact", type: "button", text: "Aplicar aos selecionados", onclick: aplicar }),
    ]);
  }

  function montarDrawer() {
    const gaveta = elemento("div", { class: "flow-drawer", id: "painel-drawer" }, [
      elemento("div", { class: "flow-drawer-painel", role: "dialog", "aria-modal": "true", "aria-label": "Ficha da solicitação" }, [
        elemento("div", { class: "flow-drawer-head" }, [
          elemento("div", { style: "flex:1;min-width:0" }, [
            elemento("h2", { id: "painel-drawer-titulo", text: "—" }),
            elemento("p", { id: "painel-drawer-sub", text: "" }),
          ]),
          elemento("button", {
            class: "text-button", type: "button", text: "Fechar",
            onclick: () => gaveta.classList.remove("aberto"),
          }),
        ]),
        elemento("div", { class: "flow-drawer-corpo", id: "painel-drawer-corpo" }),
      ]),
    ]);
    gaveta.addEventListener("click", (evento) => {
      if (evento.target === gaveta) gaveta.classList.remove("aberto");
    });
    document.addEventListener("keydown", (evento) => {
      if (evento.key === "Escape") gaveta.classList.remove("aberto");
    });
    return gaveta;
  }

  // ---------------------------------------------------------------------------
  // Central de notificações — o aviso continua disponível mesmo após a pessoa
  // sair do painel. A linha só deixa a caixa de entrada quando é aberta ou
  // quando a equipe confirma a leitura de todas.
  // ---------------------------------------------------------------------------
  function iconeNotificacao() {
    return elemento("svg", {
      class: "flow-notificacoes-icone", viewBox: "0 0 24 24", "aria-hidden": "true",
      html: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"></path>',
    });
  }

  function iconeExcluirNotificacao() {
    return elemento("svg", {
      viewBox: "0 0 24 24", "aria-hidden": "true",
      html: '<path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"></path>',
    });
  }

  function desenharNotificacoes() {
    const botao = document.getElementById("painel-notificacoes-botao");
    const menu = document.getElementById("painel-notificacoes-menu");
    if (!botao || !menu) return;

    const total = Math.max(0, Number(estado.notificacoesTotal) || 0);
    botao.setAttribute("aria-expanded", estado.notificacoesAbertas ? "true" : "false");
    botao.setAttribute("aria-label", total
      ? `Notificações: ${total} não lida${total === 1 ? "" : "s"}`
      : "Notificações: nenhuma não lida");
    const conteudoBotao = [
      iconeNotificacao(),
      elemento("span", { text: "Notificações" }),
    ];
    if (total) {
      conteudoBotao.push(elemento("span", {
        class: "flow-notificacoes-badge", text: total > 99 ? "99+" : String(total),
        "aria-live": "polite",
      }));
    }
    botao.replaceChildren(...conteudoBotao);

    menu.hidden = !estado.notificacoesAbertas;
    const bloqueada = estado.notificacoesMarcando || estado.notificacoesExcluindoTodas
      || Boolean(estado.notificacaoExcluindoId);
    const acoesCabecalho = [];
    if (total) {
      acoesCabecalho.push(elemento("button", {
        class: "text-button compact", type: "button",
        text: estado.notificacoesMarcando ? "Confirmando…" : "Marcar lidas",
        disabled: bloqueada, onclick: marcarTodasNotificacoes,
      }));
    }
    if (estado.notificacoes.length) {
      acoesCabecalho.push(elemento("button", {
        class: "text-button compact danger", type: "button",
        text: estado.notificacoesExcluindoTodas ? "Excluindo…" : "Excluir todas",
        disabled: bloqueada, onclick: excluirTodasNotificacoes,
      }));
    }

    const cabecalho = elemento("div", { class: "flow-notificacoes-cabecalho" }, [
      elemento("div", {}, [
        elemento("strong", { text: "Notificações" }),
        elemento("small", { text: total
          ? `${total} não lida${total === 1 ? "" : "s"}`
          : "Tudo revisado" }),
      ]),
      acoesCabecalho.length
        ? elemento("div", { class: "flow-notificacoes-acoes" }, acoesCabecalho)
        : null,
    ]);

    let conteudo;
    if (estado.notificacoesErro) {
      conteudo = elemento("div", { class: "flow-notificacoes-vazio erro" }, [
        elemento("strong", { text: "Não foi possível carregar" }),
        elemento("span", { text: estado.notificacoesErro }),
        elemento("button", {
          class: "text-button compact", type: "button", text: "Tentar novamente",
          onclick: carregarNotificacoes,
        }),
      ]);
    } else if (!estado.notificacoes.length) {
      conteudo = elemento("div", { class: "flow-notificacoes-vazio" }, [
        elemento("strong", { text: "Nenhuma pendência nova" }),
        elemento("span", { text: "As próximas solicitações aparecerão aqui." }),
      ]);
    } else {
      conteudo = elemento("div", { class: "flow-notificacoes-lista" },
        estado.notificacoes.map((notificacao) => {
          const titulo = texto(notificacao.title) || "Nova solicitação";
          const corpo = texto(notificacao.body) || "Abra para consultar os detalhes.";
          const lida = Boolean(notificacao.read_at);
          const excluindo = estado.notificacaoExcluindoId === notificacao.id;
          return elemento("div", {
            class: `flow-notificacao-item ${lida ? "lida" : "nao-lida"}`,
          }, [
            elemento("button", {
              class: "flow-notificacao-abrir", type: "button",
              "aria-label": `${titulo}. ${corpo}. ${lida ? "Lida" : "Não lida"}. Abrir solicitação`,
              disabled: excluindo || estado.notificacoesExcluindoTodas,
              onclick: () => abrirNotificacao(notificacao),
            }, [
              elemento("span", { class: "flow-notificacao-item-topo" }, [
                elemento("strong", { text: titulo }),
                elemento("time", {
                  datetime: texto(notificacao.created_at), text: dataHora(notificacao.created_at),
                }),
              ]),
              elemento("span", { class: "flow-notificacao-item-corpo", text: corpo }),
            ]),
            elemento("button", {
              class: "flow-notificacao-excluir", type: "button",
              title: "Excluir notificação", "aria-label": `Excluir notificação: ${titulo}`,
              disabled: excluindo || estado.notificacoesExcluindoTodas,
              onclick: () => excluirNotificacao(notificacao),
            }, [iconeExcluirNotificacao()]),
          ]);
        })
      );
    }
    menu.replaceChildren(cabecalho, conteudo);
  }

  async function carregarNotificacoes({ silencioso = false } = {}) {
    if (estado.notificacoesCarregando) return;
    estado.notificacoesCarregando = true;
    if (!silencioso) estado.notificacoesErro = "";
    try {
      const [lista, contagem] = await Promise.all([
        Api.notificacoes.listar(),
        Api.notificacoes.contarNaoLidas(),
      ]);
      if (lista.error || contagem.error) {
        if (!silencioso) estado.notificacoesErro = lista.error || contagem.error;
        return;
      }
      estado.notificacoesErro = "";
      estado.notificacoes = lista.data || [];
      estado.notificacoesTotal = Math.max(0, Number(contagem.data) || 0);
    } finally {
      estado.notificacoesCarregando = false;
      desenharNotificacoes();
    }
  }

  async function abrirNotificacao(notificacao) {
    estado.notificacoesAbertas = false;
    desenharNotificacoes();
    if (!notificacao.read_at) {
      const { error } = await Api.notificacoes.marcarLida(notificacao.id);
      if (error) {
        avisar(error, "erro");
      } else {
        notificacao.read_at = new Date().toISOString();
        estado.notificacoesTotal = Math.max(0, estado.notificacoesTotal - 1);
        desenharNotificacoes();
      }
    }
    if (!notificacao.request_id) return;
    if (estado.aba !== "solicitacoes") {
      estado.aba = "solicitacoes";
      renderAba();
      carregarSolicitacoes();
    }
    abrirFicha(notificacao.request_id);
  }

  async function marcarTodasNotificacoes() {
    if (estado.notificacoesMarcando) return;
    estado.notificacoesMarcando = true;
    desenharNotificacoes();
    const { error } = await Api.notificacoes.marcarTodasLidas();
    estado.notificacoesMarcando = false;
    if (error) {
      avisar(error, "erro");
      desenharNotificacoes();
      return;
    }
    const agora = new Date().toISOString();
    estado.notificacoes.forEach((notificacao) => { notificacao.read_at = notificacao.read_at || agora; });
    estado.notificacoesTotal = 0;
    desenharNotificacoes();
    avisar("Notificações revisadas.", "ok");
  }

  async function excluirNotificacao(notificacao) {
    if (estado.notificacaoExcluindoId || estado.notificacoesExcluindoTodas) return;
    if (!Ui.confirmar("Excluir esta notificação permanentemente?")) return;
    estado.notificacaoExcluindoId = notificacao.id;
    desenharNotificacoes();
    const { error } = await Api.notificacoes.excluir(notificacao.id);
    estado.notificacaoExcluindoId = "";
    if (error) {
      avisar(error, "erro");
      desenharNotificacoes();
      return;
    }
    estado.notificacoes = estado.notificacoes.filter((item) => item.id !== notificacao.id);
    if (!notificacao.read_at) estado.notificacoesTotal = Math.max(0, estado.notificacoesTotal - 1);
    desenharNotificacoes();
    avisar("Notificação excluída.", "ok");
  }

  async function excluirTodasNotificacoes() {
    if (estado.notificacaoExcluindoId || estado.notificacoesExcluindoTodas) return;
    if (!Ui.confirmar("Excluir permanentemente todas as suas notificações?")) return;
    estado.notificacoesExcluindoTodas = true;
    desenharNotificacoes();
    const { error } = await Api.notificacoes.excluirTodas();
    estado.notificacoesExcluindoTodas = false;
    if (error) {
      avisar(error, "erro");
      desenharNotificacoes();
      return;
    }
    estado.notificacoes = [];
    estado.notificacoesTotal = 0;
    desenharNotificacoes();
    avisar("Notificações excluídas.", "ok");
  }

  function instalarAtualizacaoNotificacoes() {
    const atualizar = () => {
      if (document.visibilityState === "visible") carregarNotificacoes({ silencioso: true });
    };
    const intervalo = root.setInterval(atualizar, INTERVALO_NOTIFICACOES_MS);
    root.addEventListener("focus", atualizar);
    document.addEventListener("visibilitychange", atualizar);
    return () => {
      root.clearInterval(intervalo);
      root.removeEventListener("focus", atualizar);
      document.removeEventListener("visibilitychange", atualizar);
    };
  }

  function montarCentralNotificacoes() {
    const central = elemento("div", { class: "flow-notificacoes" }, [
      elemento("button", {
        id: "painel-notificacoes-botao", class: "flow-notificacoes-botao", type: "button",
        "aria-haspopup": "true", "aria-controls": "painel-notificacoes-menu",
        onclick: () => {
          estado.notificacoesAbertas = !estado.notificacoesAbertas;
          desenharNotificacoes();
        },
      }),
      elemento("div", {
        id: "painel-notificacoes-menu", class: "flow-notificacoes-menu",
        role: "region", "aria-label": "Notificações não lidas", hidden: true,
      }),
    ]);
    document.addEventListener("click", (evento) => {
      // composedPath preserva a origem do clique mesmo quando o botão é
      // redesenhado no próprio evento e o nó original sai do DOM.
      if (!estado.notificacoesAbertas || evento.composedPath().includes(central)) return;
      estado.notificacoesAbertas = false;
      desenharNotificacoes();
    });
    document.addEventListener("keydown", (evento) => {
      if (evento.key !== "Escape" || !estado.notificacoesAbertas) return;
      estado.notificacoesAbertas = false;
      desenharNotificacoes();
      document.getElementById("painel-notificacoes-botao")?.focus();
    });
    return central;
  }

  const ABAS = [
    { chave: "solicitacoes", rotulo: "Solicitações" },
    { chave: "lds", rotulo: "Base de LDs", admin: true },
    { chave: "normas", rotulo: "Normas e códigos", admin: true },
    { chave: "tipos", rotulo: "Tipos de solicitação", admin: true },
    { chave: "usuarios", rotulo: "Usuários", admin: true },
    { chave: "acesso", rotulo: "Acesso", admin: true },
  ];

  function renderAba() {
    const conteudo = document.getElementById("painel-conteudo");
    if (!conteudo) return;
    document.querySelectorAll("[data-aba]").forEach((botao) => {
      botao.setAttribute("aria-selected", botao.dataset.aba === estado.aba ? "true" : "false");
    });

    pararAtualizacaoArmazenamento();
    if (estado.aba === "solicitacoes") {
      const blocos = [
        elemento("div", { id: "painel-indicadores", class: "flow-indicadores" }),
      ];
      // Capacidade do projeto é visível somente ao proprietário. Não deixamos
      // um bloco vazio nem fazemos a RPC para administradores/operadores.
      if (Api.auth.ehProprietario()) {
        blocos.push(elemento("div", { id: "painel-armazenamento", class: "flow-armazenamento carregando" }));
      }
      blocos.push(montarFiltros(), montarLote(), elemento("div", { id: "painel-tabela" }));
      conteudo.replaceChildren(...blocos);
      montarIndicadores(document.getElementById("painel-indicadores"));
      if (Api.auth.ehProprietario()) {
        montarArmazenamento(document.getElementById("painel-armazenamento"));
        iniciarAtualizacaoArmazenamento();
      }
      desenharTabela();
    } else if (estado.aba === "lds") {
      root.FlowLd.montar(conteudo);
    } else if (estado.aba === "normas") {
      root.FlowNormas.montar(conteudo);
    } else if (estado.aba === "tipos") {
      root.FlowAdmin.montarTipos(conteudo, estado.tipos, recarregarTipos);
    } else if (estado.aba === "usuarios") {
      root.FlowAdmin.montarUsuarios(conteudo);
    } else if (estado.aba === "acesso") {
      root.FlowAdmin.montarAcesso(conteudo);
    }
  }

  async function recarregarTipos() {
    const { data } = await Api.tipos.listar({ incluirInativos: true });
    estado.tipos = data || [];
    estado.tiposPorCodigo = new Map(estado.tipos.map((tipo) => [tipo.code, tipo]));
    renderAba();
  }

  function montarPagina() {
    const admin = Api.auth.ehAdmin();
    const abas = elemento("div", { class: "flow-abas", role: "tablist" },
      ABAS.filter((aba) => !aba.admin || admin).map((aba) => elemento("button", {
        class: "flow-aba", type: "button", role: "tab", "data-aba": aba.chave,
        "aria-selected": aba.chave === estado.aba ? "true" : "false",
        text: aba.rotulo,
        onclick: () => { estado.aba = aba.chave; renderAba(); },
      }))
    );

    app.replaceChildren(
      Ui.montarTopo({ ativo: "painel", subtitulo: "Painel operacional" }),
      elemento("main", { class: "flow-main largo" }, [
        elemento("div", { class: "flow-page-head" }, [
          elemento("h1", { text: "Solicitações" }),
          montarCentralNotificacoes(),
        ]),
        abas,
        elemento("div", { id: "painel-conteudo" }),
      ]),
      montarDrawer(),
      Ui.montarRodape()
    );
    renderAba();
    carregarSolicitacoes();
  }

  (async function iniciar() {
    const perfil = await Ui.exigirSessao({ equipe: true });
    if (!perfil) return;
    const { data } = await Api.tipos.listar({ incluirInativos: true });
    estado.tipos = data || [];
    estado.tiposPorCodigo = new Map(estado.tipos.map((tipo) => [tipo.code, tipo]));
    montarPagina();
    const pararNotificacoes = Api.notificacoes.assinar((notificacao) => {
      avisar(texto(notificacao.title) || "Nova solicitação recebida.", "ok");
      if (!estado.notificacoes.some((item) => item.id === notificacao.id)) {
        estado.notificacoes.unshift(notificacao);
        estado.notificacoes = estado.notificacoes.slice(0, 50);
        estado.notificacoesTotal += 1;
        estado.notificacoesErro = "";
        desenharNotificacoes();
      }
      if (estado.aba === "solicitacoes") {
        carregarSolicitacoes();
        const indicadores = document.getElementById("painel-indicadores");
        if (indicadores) montarIndicadores(indicadores);
      }
    });
    carregarNotificacoes();
    const pararAtualizacaoNotificacoes = instalarAtualizacaoNotificacoes();
    root.addEventListener("beforeunload", () => {
      pararNotificacoes();
      pararAtualizacaoNotificacoes();
    }, { once: true });
  })();
})(window);
