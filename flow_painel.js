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
  const ROTULOS_LISTA = (root.FlowExport && root.FlowExport.COLUNAS_PAINEL
    ? root.FlowExport.COLUNAS_PAINEL.map((coluna) =>
      coluna.header.charAt(0) + coluna.header.slice(1).toLocaleLowerCase("pt-BR"))
    : ["Protocolo", "Prioridade", "Tipo", "Origem", "Solicitante", "Recebida",
       "Responsável", "Progresso", "Status", "Prazo"]);

  // Cada cabeçalho e a coluna do banco por onde ele ordena, na ordem em que as
  // células são desenhadas. `null` é coluna que não ordena: progresso é uma
  // razão entre dois números, e ordenar por `items_done` colocaria 2 de 10 na
  // frente de 2 de 2 — uma ordem que a coluna não mostra.
  //
  // Data e prazo começam pela mais recente/mais próxima; texto começa em A–Z.
  // É o primeiro clique que a pessoa espera em cada caso.
  const ORDENS_DA_LISTA = Object.freeze([
    { coluna: "protocol", ascendentePrimeiro: false },
    // "urgente" > "normal" > "baixa" > "alta" em ordem alfabética não ajuda
    // ninguém; por isso o primeiro clique traz o fim do alfabeto, onde "urgente"
    // está. É a ordem que a operação quer: os urgentes primeiro.
    { coluna: "priority", ascendentePrimeiro: false },
    { coluna: "type_label", ascendentePrimeiro: true },
    // Ascendente primeiro põe "a_confirmar" no topo, e é onde ele deve estar:
    // é o único dos cinco valores que depende de uma pessoa identificar um
    // código antes de o pedido andar. Os dois caminhos decididos podem esperar.
    { coluna: "origin", ascendentePrimeiro: true },
    { coluna: "requester_name", ascendentePrimeiro: true },
    { coluna: "created_at", ascendentePrimeiro: false },
    { coluna: "owner_name", ascendentePrimeiro: true },
    null,
    { coluna: "status", ascendentePrimeiro: true },
    { coluna: "due_at", ascendentePrimeiro: true },
  ]);

  const COLUNAS_LISTA = ROTULOS_LISTA.map((rotulo, indice) => ({
    rotulo, ordem: ORDENS_DA_LISTA[indice] || null,
  }));
  const TAMANHOS_DE_PAGINA = [25, 50, 100, 200];
  const TAMANHO_PADRAO = 50;
  const INTERVALO_NOTIFICACOES_MS = 60000;
  const INTERVALO_ARMAZENAMENTO_MS = 30000;
  let pararObservacaoArmazenamento = null;
  let timerArmazenamento = null;

  const estado = {
    aba: "solicitacoes",
    tipos: [],
    tiposPorCodigo: new Map(),
    // Quem pode ser responsável. Carregado uma vez: é a lista que transforma o
    // nome digitado em pessoa de verdade, e sem ela o aviso não teria destino.
    equipe: [],
    solicitacoes: [],
    filtros: { busca: "", tipo: "", status: "", classificacao: "", prioridade: "", origem: "", indicador: "" },
    // Protocolo junto do id: a seleção atravessa páginas e a exportação de
    // "só selecionadas" precisa do protocolo de linhas que já saíram da tela.
    selecionadas: new Map(),
    pagina: 1,
    porPagina: TAMANHO_PADRAO,
    total: 0,
    // A mesma ordem que a consulta usava antes de a coluna virar clicável.
    ordem: { coluna: "created_at", ascendente: false },
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
        const situacao = Ui.situacaoAlocacao(item);
        if (situacao.estado === "identificada") return elemento("code", { text: situacao.codigo });
        // A LD afirma que está alocado e não diz em qual GRDT. Mostrar "—" aqui
        // fazia a linha parecer não apurada, quando na verdade a informação
        // apurada é justamente essa: falta o código na LD de origem.
        if (situacao.estado === "confirmada") {
          return elemento("span", { class: "flow-selo validar", text: situacao.rotulo });
        }
        if (situacao.estado === "nao-aplicavel") {
          return elemento("span", { style: "color:var(--text-3)", text: situacao.rotulo });
        }
        return elemento("span", { class: "flow-selo acao", text: situacao.rotulo });
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
    norm_family: {
      rotulo: "Norma",
      celula: (item) => Ui.seloFamilia(item.norm_family)
        || elemento("span", { style: "color:var(--text-3)", text: "—" }),
    },
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
    { chave: "urgentesAbertas", rotulo: "Urgentes em aberto", classe: "alerta", filtro: { urgentes: true } },
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
    estado.filtros = {
      busca: estado.filtros.busca, tipo: estado.filtros.tipo,
      status: "", classificacao: "", prioridade: "", origem: "", indicador: "",
    };
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
  /** Os filtros da tela na forma que a camada de dados entende. */
  function filtrosDaConsulta() {
    const f = estado.filtros;
    const filtros = {};
    if (f.busca) filtros.busca = f.busca;
    if (f.tipo) filtros.tipo = f.tipo;
    if (f.status) filtros.status = f.status;
    if (f.abertas) filtros.abertas = true;
    if (f.atrasadas) filtros.atrasadas = true;
    if (f.semResponsavel) filtros.semResponsavel = true;
    if (f.classificacao) filtros.classificacao = f.classificacao;
    if (f.urgentes) filtros.urgentes = true;
    if (f.prioridade) filtros.prioridade = f.prioridade;
    if (f.origem) filtros.origem = f.origem;
    if (f.hoje) filtros.de = `${new Date().toISOString().slice(0, 10)}T00:00:00`;
    // A ordem entra aqui, e não só na listagem: `protocolos` tem teto, e qual
    // fatia cabe nele depende de como a lista está ordenada.
    filtros.ordem = estado.ordem;
    return filtros;
  }

  function totalDePaginas() {
    return Math.max(1, Math.ceil(estado.total / estado.porPagina));
  }

  /**
   * Carrega uma página. Trocar filtro volta para a primeira: continuar na
   * página 7 de um recorte que agora tem duas páginas mostraria uma tabela
   * vazia, e a pessoa concluiria que o filtro não achou nada.
   */
  async function carregarSolicitacoes({ manterPagina = false } = {}) {
    const corpo = document.getElementById("painel-tabela");
    if (corpo) Ui.carregando(corpo);
    estado.carregando = true;
    if (!manterPagina) estado.pagina = 1;

    const filtros = filtrosDaConsulta();
    filtros.limite = estado.porPagina;
    filtros.inicio = (estado.pagina - 1) * estado.porPagina;

    const { data, total, error } = await Api.solicitacoes.listar(filtros);
    estado.carregando = false;
    if (error) {
      avisar(error, "erro");
      estado.solicitacoes = [];
      estado.total = 0;
    } else {
      estado.solicitacoes = data || [];
      estado.total = Number(total) || 0;
    }

    // A página pode ter deixado de existir enquanto ninguém olhava — outra
    // pessoa concluiu solicitações, o recorte encolheu. Recua uma vez em vez de
    // mostrar o vazio.
    if (!estado.solicitacoes.length && estado.pagina > 1 && estado.total > 0) {
      estado.pagina = Math.min(estado.pagina - 1, totalDePaginas());
      return carregarSolicitacoes({ manterPagina: true });
    }

    desenharTabela();
    return undefined;
  }

  function irParaPagina(numero) {
    const alvo = Math.min(Math.max(1, numero), totalDePaginas());
    if (alvo === estado.pagina) return;
    estado.pagina = alvo;
    carregarSolicitacoes({ manterPagina: true });
    const tabela = document.getElementById("painel-tabela");
    if (tabela) tabela.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function desenharTabela() {
    const destino = document.getElementById("painel-tabela");
    if (!destino) return;
    if (!estado.solicitacoes.length) {
      destino.replaceChildren(elemento("div", { class: "flow-vazio" }, [
        elemento("strong", { text: "Nenhuma solicitação com esses filtros" }),
        elemento("span", { text: "Ajuste a busca ou limpe os filtros para ver tudo que está aberto." }),
      ]));
      atualizarBarraDeLote();
      return;
    }

    // "Todas" é todas desta página. Marcar não apaga o que ficou selecionado nas
    // outras: a seleção é do recorte, não da tela.
    const todas = elemento("input", { type: "checkbox", "aria-label": "Selecionar todas as desta página" });
    todas.checked = estado.solicitacoes.length > 0
      && estado.solicitacoes.every((s) => estado.selecionadas.has(s.id));
    todas.addEventListener("change", () => {
      estado.solicitacoes.forEach((s) => {
        if (todas.checked) estado.selecionadas.set(s.id, s.protocol);
        else estado.selecionadas.delete(s.id);
      });
      desenharTabela();
    });

    const cabecalho = elemento("tr", {}, [
      elemento("th", { class: "col-check" }, [todas]),
      ...COLUNAS_LISTA.map((coluna) => montarCabecalho(coluna)),
    ]);

    const corpo = elemento("tbody");
    estado.solicitacoes.forEach((solicitacao) => {
      const fechada = ["concluido", "cancelado"].includes(solicitacao.status);
      const proporcao = solicitacao.items_total > 0
        ? Math.round((solicitacao.items_done / solicitacao.items_total) * 100) : 0;

      const marcar = elemento("input", {
        type: "checkbox", "aria-label": `Selecionar ${solicitacao.protocol}`,
        checked: estado.selecionadas.has(solicitacao.id) || null,
      });
      // Marcar uma linha não redesenha a tabela: além de custar caro, tirava o
      // foco da caixa e quebrava o Tab de quem seleciona várias em sequência.
      marcar.addEventListener("change", () => {
        if (marcar.checked) estado.selecionadas.set(solicitacao.id, solicitacao.protocol);
        else estado.selecionadas.delete(solicitacao.id);
        linha.classList.toggle("selecionada", marcar.checked);
        todas.checked = estado.solicitacoes.length > 0
          && estado.solicitacoes.every((s) => estado.selecionadas.has(s.id));
        atualizarBarraDeLote();
      });

      const destaque = Ui.prioridadeEmDestaque(solicitacao.priority)
        && !["concluido", "cancelado"].includes(solicitacao.status);
      const classes = [
        estado.selecionadas.has(solicitacao.id) ? "selecionada" : "",
        // A faixa é o "vermelho" que o controle em papel pedia. Some quando o
        // pedido fecha: urgência de coisa concluída não é fila de trabalho.
        destaque ? `urgente-${texto(solicitacao.priority)}` : "",
      ].filter(Boolean).join(" ");

      const linha = elemento("tr", { class: classes }, [
        elemento("td", {}, [marcar]),
        elemento("td", {}, [
          elemento("button", {
            class: "protocolo", type: "button", text: solicitacao.protocol,
            onclick: () => abrirFicha(solicitacao.id),
          }),
        ]),
        elemento("td", {}, [
          Ui.seloPrioridade(solicitacao.priority)
            || elemento("span", { style: "color:var(--text-3)", text: "—" }),
        ]),
        elemento("td", { text: solicitacao.type_label }),
        elemento("td", {}, [
          Ui.seloOrigem(solicitacao.origin)
            || elemento("span", { style: "color:var(--text-3)", text: "—" }),
        ]),
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
      ]);
      corpo.append(linha);
    });

    destino.replaceChildren(
      montarResumoDaLista(),
      elemento("div", { class: "flow-tabela-wrap" }, [
        elemento("table", { class: "flow-tabela lista" }, [
          elemento("thead", {}, [cabecalho]), corpo,
        ]),
      ]),
      montarPaginacao()
    );

    atualizarBarraDeLote();
  }

  const SETAS_DA_ORDEM = Object.freeze({ ascendente: "▲", descendente: "▼" });

  /**
   * Cabeçalho de coluna. Ordenar vai ao servidor, como os filtros: ordenar só a
   * página desenhada responderia "as mais antigas destas 50", não as mais
   * antigas da base — e a pessoa não teria como saber a diferença.
   */
  function montarCabecalho(coluna) {
    if (!coluna.ordem) return elemento("th", { text: coluna.rotulo });

    const ativa = estado.ordem.coluna === coluna.ordem.coluna;
    const sentido = ativa && estado.ordem.ascendente ? "ascending" : ativa ? "descending" : "none";
    const seta = ativa
      ? (estado.ordem.ascendente ? SETAS_DA_ORDEM.ascendente : SETAS_DA_ORDEM.descendente)
      : "";

    const botao = elemento("button", {
      class: `flow-ordenar ${ativa ? "ativa" : ""}`, type: "button",
      // O leitor de tela precisa ouvir o que o clique vai fazer, não o que a
      // seta já mostra.
      "aria-label": ativa && estado.ordem.ascendente
        ? `${coluna.rotulo} · ordenado do menor para o maior. Clique para inverter.`
        : ativa
          ? `${coluna.rotulo} · ordenado do maior para o menor. Clique para inverter.`
          : `Ordenar por ${coluna.rotulo}`,
      onclick: () => ordenarPor(coluna.ordem),
    }, [
      elemento("span", { text: coluna.rotulo }),
      elemento("span", { class: "flow-ordenar-seta", "aria-hidden": "true", text: seta }),
    ]);

    return elemento("th", { "aria-sort": sentido }, [botao]);
  }

  function ordenarPor(ordem) {
    const ativa = estado.ordem.coluna === ordem.coluna;
    estado.ordem = {
      coluna: ordem.coluna,
      // Repetir a coluna inverte; trocar de coluna começa pelo sentido que faz
      // sentido para aquele dado.
      ascendente: ativa ? !estado.ordem.ascendente : Boolean(ordem.ascendentePrimeiro),
    };
    // A ordem muda o que "página 1" significa: continuar na 4 mostraria um
    // pedaço do meio de uma lista que a pessoa acabou de reorganizar.
    carregarSolicitacoes();
  }

  /** "Mostrando 51–100 de 312" — a conta que responde "cadê o resto?". */
  function montarResumoDaLista() {
    const primeira = (estado.pagina - 1) * estado.porPagina + 1;
    const ultima = primeira + estado.solicitacoes.length - 1;
    const selecionadas = estado.selecionadas.size;
    return elemento("p", { class: "flow-lista-resumo" }, [
      elemento("strong", { text: estado.total
        ? `Mostrando ${primeira.toLocaleString("pt-BR")}–${ultima.toLocaleString("pt-BR")} de ${estado.total.toLocaleString("pt-BR")}`
        : "Nenhuma solicitação nesse recorte" }),
      selecionadas ? ` · ${selecionadas.toLocaleString("pt-BR")} selecionada(s) no total` : "",
    ]);
  }

  function montarPaginacao() {
    const paginas = totalDePaginas();
    const tamanho = elemento("select", { id: "painel-por-pagina", "aria-label": "Solicitações por página" });
    TAMANHOS_DE_PAGINA.forEach((valor) => {
      const opcao = elemento("option", { value: String(valor), text: `${valor} por página` });
      if (valor === estado.porPagina) opcao.selected = true;
      tamanho.append(opcao);
    });
    tamanho.addEventListener("change", () => {
      estado.porPagina = Number(tamanho.value) || TAMANHO_PADRAO;
      carregarSolicitacoes();
    });

    const botao = (rotulo, destino, desabilitado, aria) => elemento("button", {
      class: "secondary-button compact", type: "button", text: rotulo,
      "aria-label": aria || rotulo, disabled: desabilitado || null,
      onclick: () => irParaPagina(destino),
    });

    return elemento("div", { class: "flow-paginacao" }, [
      tamanho,
      elemento("span", { class: "flow-paginacao-espaco" }),
      botao("‹‹", 1, estado.pagina <= 1, "Primeira página"),
      botao("‹ Anterior", estado.pagina - 1, estado.pagina <= 1, "Página anterior"),
      elemento("span", { class: "flow-paginacao-posicao", "aria-live": "polite",
        text: `Página ${estado.pagina.toLocaleString("pt-BR")} de ${paginas.toLocaleString("pt-BR")}` }),
      botao("Próxima ›", estado.pagina + 1, estado.pagina >= paginas, "Próxima página"),
      botao("››", paginas, estado.pagina >= paginas, "Última página"),
    ]);
  }

  function atualizarBarraDeLote() {
    const barra = document.getElementById("painel-lote");
    if (barra) barra.hidden = estado.selecionadas.size === 0;
    const contagem = document.getElementById("painel-lote-contagem");
    if (contagem) contagem.textContent = `${estado.selecionadas.size} selecionada(s)`;
  }

  // ---------------------------------------------------------------------------
  // Ficha da solicitação
  // ---------------------------------------------------------------------------
  async function abrirFicha(id) {
    const corpo = document.getElementById("painel-drawer-corpo");
    const titulo = document.getElementById("painel-drawer-titulo");
    abrirGaveta();
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
    dado("Prioridade", null, Ui.seloPrioridade(data.priority)
      || elemento("span", { text: Ui.rotuloPrioridade(data.priority || Ui.PRIORIDADE_PADRAO) }));
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

    // Sugestão com os nomes da equipe, não uma lista fechada: o responsável
    // pode ser alguém sem conta no aplicativo, e recusar esse caso seria pior
    // do que registrá-lo. O que a tela não pode é deixar a diferença invisível
    // — daí o aviso abaixo.
    const sugestoes = elemento("datalist", { id: "acao-responsavel-opcoes" });
    estado.equipe.forEach((pessoa) => {
      sugestoes.append(elemento("option", { value: texto(pessoa.full_name) }));
    });

    const responsavel = elemento("input", {
      id: "acao-responsavel", type: "text", autocomplete: "off",
      list: "acao-responsavel-opcoes", placeholder: "Nome de quem executa",
    });
    responsavel.value = texto(solicitacao.owner_name);

    const avisoResponsavel = elemento("small", {
      id: "acao-responsavel-aviso",
      style: "display:block;margin-top:.25rem;color:var(--warning-800)",
    });
    const conferirResponsavel = () => {
      const nome = texto(responsavel.value);
      const daEquipe = estado.equipe.some(
        (pessoa) => texto(pessoa.full_name).toLocaleUpperCase("pt-BR") === nome.toLocaleUpperCase("pt-BR")
      );
      avisoResponsavel.textContent = !nome || daEquipe
        ? ""
        : "Esta pessoa não está na equipe do aplicativo e não receberá aviso.";
    };
    responsavel.addEventListener("input", conferirResponsavel);
    conferirResponsavel();

    const prioridade = elemento("select", { id: "acao-prioridade" });
    Object.entries(Ui.PRIORIDADES).forEach(([valor, info]) => {
      const node = elemento("option", { value: valor, text: info.rotulo });
      if (valor === (texto(solicitacao.priority) || Ui.PRIORIDADE_PADRAO)) node.selected = true;
      prioridade.append(node);
    });

    const prazo = elemento("input", { id: "acao-prazo", type: "date" });
    prazo.value = texto(solicitacao.due_at);

    const resposta = elemento("textarea", { id: "acao-resposta", rows: "3", placeholder: "Resposta ao solicitante — o que ele vai ler ao acompanhar." });
    resposta.value = texto(solicitacao.answer);

    const botaoSalvar = elemento("button", { class: "primary-button", type: "button", text: "Salvar" });
    const botaoReprocessar = tipo && tipo.uses_ld
      ? elemento("button", { class: "secondary-button", type: "button", text: "Reprocessar triagem" })
      : null;

    const salvar = async () => {
      const alteracoes = [
        ["status", status.value, solicitacao.status],
        ["priority", prioridade.value, texto(solicitacao.priority) || Ui.PRIORIDADE_PADRAO],
        ["owner_name", responsavel.value, solicitacao.owner_name],
        ["due_at", prazo.value, solicitacao.due_at || ""],
        ["answer", resposta.value, solicitacao.answer],
      ].filter(([, novo, antigo]) => texto(novo) !== texto(antigo));

      if (!alteracoes.length) { avisar("Nada mudou."); return; }
      // Sem travar o botão, um duplo clique dispara a mesma alteração duas vezes
      // e o histórico ganha um evento que nunca aconteceu.
      botaoSalvar.disabled = true;
      botaoSalvar.textContent = "Salvando…";
      for (const [campo, valor] of alteracoes) {
        const { error } = await Api.solicitacoes.atualizar(solicitacao.id, campo, valor, "");
        if (error) {
          botaoSalvar.disabled = false;
          botaoSalvar.textContent = "Salvar";
          avisar(error, "erro");
          return;
        }
      }
      avisar("Solicitação atualizada.", "ok");
      abrirFicha(solicitacao.id);
      carregarSolicitacoes({ manterPagina: true });
      montarIndicadores(document.getElementById("painel-indicadores"));
    };

    const reprocessar = async () => {
      if (!tipo || !tipo.uses_ld) { avisar("Este tipo não usa consulta às LDs."); return; }
      if (botaoReprocessar) { botaoReprocessar.disabled = true; botaoReprocessar.textContent = "Reprocessando…"; }
      avisar("Reprocessando com as LDs vigentes…");
      const { error } = await Api.triagem.solicitacao(solicitacao.id);
      if (botaoReprocessar) { botaoReprocessar.disabled = false; botaoReprocessar.textContent = "Reprocessar triagem"; }
      if (error) { avisar(error, "erro"); return; }
      avisar("Triagem reprocessada. O resultado anterior foi preservado no histórico.", "ok");
      abrirFicha(solicitacao.id);
    };

    botaoSalvar.addEventListener("click", salvar);
    if (botaoReprocessar) botaoReprocessar.addEventListener("click", reprocessar);

    const excluir = async (evento) => {
      const botao = evento.currentTarget;
      const protocolo = texto(solicitacao.protocol).toUpperCase();
      // Uma caixa só, que mostra o que vai sumir e só libera o botão quando o
      // protocolo confere. O par prompt+confirm perguntava duas vezes e, na
      // segunda, já não dizia de qual solicitação estava falando.
      const confirmado = await Ui.confirmar(
        `Excluir permanentemente ${protocolo}?\n\nSaem junto os itens, as triagens, o histórico, os comentários e os anexos. Não há como desfazer.`,
        {
          titulo: "Excluir solicitação",
          rotuloConfirmar: "Excluir permanentemente",
          rotuloCancelar: "Manter",
          perigo: true,
          exigirTexto: protocolo,
        }
      );
      if (!confirmado) return;

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
      fecharGaveta();
      avisar(`${protocolo} excluída permanentemente.`, "ok");
      await carregarSolicitacoes({ manterPagina: true });
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
        elemento("label", { class: "flow-campo", for: "acao-prioridade" }, [
          elemento("span", { text: "Prioridade" }),
          elemento("small", { text: "Urgente e alta destacam a linha no painel e entram no cartão de urgentes." }),
          prioridade,
        ]),
        elemento("label", { class: "flow-campo", for: "acao-responsavel" }, [
          elemento("span", { text: "Responsável" }), responsavel, sugestoes, avisoResponsavel,
        ]),
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
        botaoSalvar,
        botaoReprocessar,
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
          onclick: async (evento) => {
            // `currentTarget` é anulado assim que o manipulador cede a vez; a
            // caixa de confirmação agora é assíncrona, então o botão é guardado
            // antes de perguntar.
            const botaoConcluir = evento.currentTarget;
            if (!await Ui.confirmar("Marcar todos os itens desta solicitação como concluídos?", {
              titulo: "Concluir itens", rotuloConfirmar: "Concluir todos",
            })) return;
            botaoConcluir.disabled = true;
            botaoConcluir.textContent = "Concluindo…";
            const { error } = await Api.itens.atualizar(itens.map((i) => i.id), "status", "concluido", "Concluído em lote pela ficha");
            if (error) {
              botaoConcluir.disabled = false;
              botaoConcluir.textContent = "Concluir todos os itens";
              avisar(error, "erro");
              return;
            }
            avisar("Itens concluídos.", "ok");
            abrirFicha(solicitacao.id);
            carregarSolicitacoes({ manterPagina: true });
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
        // Qual norma rege este código. Fica junto da classificação porque as
        // duas respondem à mesma pergunta da equipe: o que fazer com este item.
        Ui.seloFamilia(item.norm_family),
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
              if (!await Ui.confirmar(
                `Confirmar ${candidato.document} como o código deste item?\n\n${candidato.title || ""}`.trim(),
                { titulo: "Confirmar código", rotuloConfirmar: "É este", ajuda: "O item será triado de novo com o código confirmado." }
              )) return;
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
          onclick: async (evento) => {
            const botaoItem = evento.currentTarget;
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
            botaoItem.disabled = true;
            botaoItem.textContent = "Salvando…";
            for (const [campo, valor] of alteracoes) {
              const { error } = await Api.itens.atualizar([item.id], campo, valor, "");
              if (error) {
                botaoItem.disabled = false;
                botaoItem.textContent = "Salvar item";
                avisar(error, "erro");
                return;
              }
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
      // As selecionadas podem estar espalhadas por várias páginas; por isso o
      // protocolo viaja junto do id na seleção.
      const protocolos = [...estado.selecionadas.values()].filter(Boolean);
      if (!protocolos.length) { avisar("Selecione ao menos uma solicitação.", "erro"); return; }
      filtros.protocolos = protocolos;
      descricao = `${protocolos.length} solicitação(ões) selecionada(s)`;
    } else if (escopo === "filtro") {
      // O recorte inteiro, não a página que está na tela: exportar 50 de 312
      // porque a tabela mostra 50 seria uma armadilha silenciosa.
      const { data: protocolos, error: erroProtocolos } = await Api.solicitacoes.protocolos(filtrosDaConsulta());
      if (erroProtocolos) { avisar(erroProtocolos, "erro"); return; }
      if (!protocolos.length) { avisar("Não há solicitações nesse recorte para exportar.", "erro"); return; }
      filtros.protocolos = protocolos;
      descricao = `${protocolos.length} solicitação(ões) do recorte atual do painel`;
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

    const prioridade = elemento("select", { id: "filtro-prioridade" });
    prioridade.append(elemento("option", { value: "", text: "Qualquer prioridade" }));
    Object.entries(Ui.PRIORIDADES).forEach(([valor, info]) => {
      const node = elemento("option", { value: valor, text: info.rotulo });
      if (valor === estado.filtros.prioridade) node.selected = true;
      prioridade.append(node);
    });
    prioridade.addEventListener("change", () => {
      estado.filtros.prioridade = prioridade.value;
      estado.filtros.urgentes = false;
      estado.filtros.indicador = "";
      carregarSolicitacoes();
    });

    // A bifurcação do plano do cliente como filtro de um clique. "Não se aplica"
    // fica de fora da lista de propósito: é um recorte que ninguém procura, e
    // ocupá-lo aqui empurraria para baixo os quatro que a operação usa.
    const origem = elemento("select", { id: "filtro-origem" });
    origem.append(elemento("option", { value: "", text: "Qualquer origem" }));
    Object.entries(Ui.ORIGENS)
      .filter(([valor]) => valor !== "nao_aplicavel")
      .forEach(([valor, info]) => {
        const node = elemento("option", { value: valor, text: info.rotulo });
        if (valor === estado.filtros.origem) node.selected = true;
        origem.append(node);
      });
    origem.addEventListener("change", () => {
      estado.filtros.origem = origem.value;
      estado.filtros.indicador = "";
      carregarSolicitacoes();
    });

    return elemento("div", { class: "flow-filtros" }, [
      elemento("label", { class: "flow-campo busca", for: "filtro-busca" }, [elemento("span", { text: "Buscar" }), busca]),
      elemento("label", { class: "flow-campo", for: "filtro-tipo" }, [elemento("span", { text: "Tipo" }), tipo]),
      elemento("label", { class: "flow-campo", for: "filtro-status" }, [elemento("span", { text: "Status" }), status]),
      elemento("label", { class: "flow-campo", for: "filtro-prioridade" }, [elemento("span", { text: "Prioridade" }), prioridade]),
      elemento("label", { class: "flow-campo", for: "filtro-origem" }, [elemento("span", { text: "Origem" }), origem]),
      elemento("button", {
        class: "text-button", type: "button", text: "Limpar filtros",
        onclick: () => {
          estado.filtros = { busca: "", tipo: "", status: "", classificacao: "", prioridade: "", origem: "", indicador: "" };
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
    const andamento = elemento("span", { id: "painel-lote-andamento", class: "flow-lote-andamento", hidden: true, role: "status", "aria-live": "polite" });
    const botao = elemento("button", { class: "secondary-button compact", type: "button", text: "Aplicar aos selecionados" });

    /**
     * Uma alteração em lote é uma chamada por solicitação. Antes, o primeiro
     * erro abortava o restante em silêncio e a tela ainda dizia "0 selecionadas"
     * — quem tentasse repetir não sabia o que já tinha sido aplicado. Agora o
     * lote vai até o fim, conta o que passou, e mantém selecionado exatamente o
     * que falhou.
     */
    const aplicar = async () => {
      const ids = [...estado.selecionadas.keys()];
      if (!ids.length) return;
      const tarefas = [];
      if (status.value) tarefas.push(["status", status.value]);
      if (texto(responsavel.value)) tarefas.push(["owner_name", responsavel.value]);
      if (!tarefas.length) { avisar("Escolha o que aplicar.", "erro"); return; }

      botao.disabled = true;
      status.disabled = true;
      responsavel.disabled = true;
      andamento.hidden = false;

      const falhas = [];
      let concluidas = 0;
      for (let indice = 0; indice < ids.length; indice += 1) {
        const id = ids[indice];
        andamento.textContent = `Aplicando ${indice + 1} de ${ids.length}…`;
        let erroDoItem = null;
        for (const [campo, valor] of tarefas) {
          const { error } = await Api.solicitacoes.atualizar(id, campo, valor, "Alteração em lote pelo painel");
          if (error) { erroDoItem = error; break; }
        }
        if (erroDoItem) falhas.push({ id, erro: erroDoItem });
        else concluidas += 1;
      }

      botao.disabled = false;
      status.disabled = false;
      responsavel.disabled = false;
      andamento.hidden = true;
      andamento.textContent = "";

      if (falhas.length) {
        // O que falhou continua marcado: a próxima tentativa já vem no alvo.
        const restantes = new Map();
        falhas.forEach((falha) => restantes.set(falha.id, estado.selecionadas.get(falha.id) || ""));
        estado.selecionadas = restantes;
        avisar(`${concluidas} atualizada(s), ${falhas.length} falharam: ${falhas[0].erro}`, "erro");
      } else {
        estado.selecionadas = new Map();
        status.value = ""; responsavel.value = "";
        avisar(`${concluidas} solicitação(ões) atualizada(s).`, "ok");
      }
      // O lote muda status: a página atual continua sendo a mesma pergunta.
      carregarSolicitacoes({ manterPagina: true });
      montarIndicadores(document.getElementById("painel-indicadores"));
    };

    botao.addEventListener("click", aplicar);

    return elemento("div", { class: "flow-lote", id: "painel-lote", hidden: true }, [
      elemento("strong", { id: "painel-lote-contagem", text: "0 selecionada(s)" }),
      elemento("label", { class: "flow-campo", for: "lote-status" }, [elemento("span", { text: "Novo status" }), status]),
      elemento("label", { class: "flow-campo", for: "lote-responsavel" }, [elemento("span", { text: "Responsável" }), responsavel]),
      botao,
      elemento("button", {
        class: "text-button", type: "button", text: "Limpar seleção",
        onclick: () => { estado.selecionadas = new Map(); desenharTabela(); },
      }),
      andamento,
    ]);
  }

  /**
   * A ficha abre por cima do painel. Fechá-la precisa devolver o foco ao
   * protocolo que a abriu — sem isso, quem usa teclado volta ao topo da página e
   * perde o lugar na lista — e a página de trás não pode rolar junto.
   */
  let focoAntesDaFicha = null;

  function abrirGaveta() {
    const gaveta = document.getElementById("painel-drawer");
    if (!gaveta) return;
    if (!gaveta.classList.contains("aberto")) focoAntesDaFicha = document.activeElement;
    gaveta.classList.add("aberto");
    document.body.classList.add("p1-modal-open");
    const painel = gaveta.querySelector(".flow-drawer-painel");
    if (painel) painel.focus();
  }

  function fecharGaveta() {
    const gaveta = document.getElementById("painel-drawer");
    if (!gaveta || !gaveta.classList.contains("aberto")) return;
    gaveta.classList.remove("aberto");
    document.body.classList.remove("p1-modal-open");
    estado.aberta = null;
    if (focoAntesDaFicha && focoAntesDaFicha.isConnected && typeof focoAntesDaFicha.focus === "function") {
      focoAntesDaFicha.focus();
    }
    focoAntesDaFicha = null;
  }

  function montarDrawer() {
    const gaveta = elemento("div", { class: "flow-drawer", id: "painel-drawer" }, [
      elemento("div", {
        class: "flow-drawer-painel", role: "dialog", "aria-modal": "true",
        "aria-label": "Ficha da solicitação", tabindex: "-1",
      }, [
        elemento("div", { class: "flow-drawer-head" }, [
          elemento("div", { style: "flex:1;min-width:0" }, [
            elemento("h2", { id: "painel-drawer-titulo", text: "—" }),
            elemento("p", { id: "painel-drawer-sub", text: "" }),
          ]),
          elemento("button", { class: "text-button", type: "button", text: "Fechar", onclick: fecharGaveta }),
        ]),
        elemento("div", { class: "flow-drawer-corpo", id: "painel-drawer-corpo" }),
      ]),
    ]);
    gaveta.addEventListener("click", (evento) => {
      if (evento.target === gaveta) fecharGaveta();
    });
    document.addEventListener("keydown", (evento) => {
      if (evento.key === "Escape") fecharGaveta();
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

  function podeAtivarAlertasNavegador() {
    return root.isSecureContext && "Notification" in root
      && root.Notification.permission === "default";
  }

  async function ativarAlertasNavegador() {
    if (!("Notification" in root)) return;
    const permissao = await root.Notification.requestPermission();
    desenharNotificacoes();
    avisar(permissao === "granted"
      ? "Alertas deste navegador ativados."
      : "O navegador não autorizou os alertas; eles continuam disponíveis nesta central.",
    permissao === "granted" ? "ok" : "atencao");
  }

  function notificarNoNavegador(notificacao) {
    if (!("Notification" in root) || root.Notification.permission !== "granted") return;
    try {
      const alerta = new root.Notification(texto(notificacao.title) || "Nova atividade no GRCON Flow", {
        body: texto(notificacao.body) || "Abra o painel para consultar.",
        tag: `grcon-flow-${notificacao.request_id || notificacao.id}`,
        icon: "grcon-logo-app.png",
      });
      alerta.onclick = () => {
        root.focus();
        abrirNotificacao(notificacao);
        alerta.close();
      };
    } catch (erro) {
      // Alguns navegadores móveis exigem service worker para alertas nativos.
      // O aviso persistente na central continua sendo a fonte confiável.
      console.error("[GRCON Flow · alerta do navegador]", erro);
    }
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
    if (podeAtivarAlertasNavegador()) {
      acoesCabecalho.push(elemento("button", {
        class: "text-button compact", type: "button", text: "Ativar alertas",
        onclick: ativarAlertasNavegador,
      }));
    }
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
    if (!await Ui.confirmar("Excluir esta notificação permanentemente?", {
      titulo: "Excluir notificação", rotuloConfirmar: "Excluir", rotuloCancelar: "Manter", perigo: true,
    })) return;
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
    if (!await Ui.confirmar("Excluir permanentemente todas as suas notificações?", {
      titulo: "Limpar a caixa", rotuloConfirmar: "Excluir todas", rotuloCancelar: "Manter", perigo: true,
    })) return;
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
    { chave: "solicitacoes", rotulo: "Solicitações", titulo: "Solicitações" },
    { chave: "lds", rotulo: "Base de LDs", titulo: "Base de LDs", admin: true },
    { chave: "normas", rotulo: "Normas e códigos", titulo: "Normas e códigos", admin: true },
    { chave: "tipos", rotulo: "Tipos de solicitação", titulo: "Tipos de solicitação", admin: true },
    { chave: "usuarios", rotulo: "Usuários", titulo: "Usuários", admin: true },
    { chave: "acesso", rotulo: "Acesso", titulo: "Quem pode entrar", admin: true },
  ];

  /** A aba visível vira parte do endereço: atualizar a página, voltar pelo
   *  navegador ou mandar o link a um colega passam a cair no mesmo lugar. */
  function abaDaUrl() {
    const pedida = texto(new URLSearchParams(root.location.search).get("aba"));
    const conhecida = ABAS.find((aba) => aba.chave === pedida);
    if (!conhecida) return "solicitacoes";
    if (conhecida.admin && !Api.auth.ehAdmin()) return "solicitacoes";
    return conhecida.chave;
  }

  function guardarAbaNaUrl(substituir = false) {
    const parametros = new URLSearchParams(root.location.search);
    if (estado.aba === "solicitacoes") parametros.delete("aba");
    else parametros.set("aba", estado.aba);
    const busca = parametros.toString();
    const destino = root.location.pathname + (busca ? `?${busca}` : "");
    if (substituir) root.history.replaceState({ aba: estado.aba }, "", destino);
    else root.history.pushState({ aba: estado.aba }, "", destino);
  }

  function renderAba() {
    const conteudo = document.getElementById("painel-conteudo");
    if (!conteudo) return;
    document.querySelectorAll("[data-aba]").forEach((botao) => {
      botao.setAttribute("aria-selected", botao.dataset.aba === estado.aba ? "true" : "false");
    });
    // O título da página é a única referência de "onde estou" quando a lista
    // rola e as abas saem da vista.
    const titulo = document.getElementById("painel-titulo");
    const aba = ABAS.find((item) => item.chave === estado.aba);
    if (titulo && aba) titulo.textContent = aba.titulo;

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
    const botaoRegistroRapido = Api.auth.ehEquipe() && root.FlowRegistroRapido
      ? elemento("button", {
        id: "painel-registro-rapido",
        class: "primary-button compact",
        type: "button",
        text: "+ Registrar solicitação",
        onclick: () => root.FlowRegistroRapido.abrir({
          tipos: estado.tipos,
          aoRegistrar: async (resultado) => {
            if (estado.aba !== "solicitacoes") {
              estado.aba = "solicitacoes";
              guardarAbaNaUrl();
              renderAba();
            }
            await carregarSolicitacoes({ manterPagina: false });
            const indicadores = document.getElementById("painel-indicadores");
            if (indicadores) montarIndicadores(indicadores);
            if (resultado && resultado.id) abrirSolicitacao(resultado.id);
          },
        }),
      }) : null;
    const abas = elemento("div", { class: "flow-abas", role: "tablist" },
      ABAS.filter((aba) => !aba.admin || admin).map((aba) => elemento("button", {
        class: "flow-aba", type: "button", role: "tab", "data-aba": aba.chave,
        "aria-selected": aba.chave === estado.aba ? "true" : "false",
        text: aba.rotulo,
        onclick: () => {
          if (estado.aba === aba.chave) return;
          estado.aba = aba.chave;
          guardarAbaNaUrl();
          renderAba();
        },
      }))
    );

    app.replaceChildren(
      Ui.montarTopo({ ativo: "painel", subtitulo: "Painel operacional" }),
      elemento("main", { class: "flow-main largo" }, [
        elemento("div", { class: "flow-page-head" }, [
          elemento("h1", { id: "painel-titulo", text: "Solicitações" }),
          elemento("div", { class: "flow-page-head-acoes" }, [
            botaoRegistroRapido,
            montarCentralNotificacoes(),
          ]),
        ]),
        abas,
        elemento("div", { id: "painel-conteudo" }),
      ]),
      montarDrawer(),
      Ui.montarRodape()
    );
    renderAba();
    // Abrir direto em outra aba não deve custar uma consulta de solicitações
    // que ninguém vai ver.
    if (estado.aba === "solicitacoes") carregarSolicitacoes();
  }

  (async function iniciar() {
    const perfil = await Ui.exigirSessao({ equipe: true });
    if (!perfil) return;
    const [tipos, pessoas] = await Promise.all([
      Api.tipos.listar({ incluirInativos: true }),
      Api.usuarios.equipe(),
    ]);
    estado.tipos = tipos.data || [];
    estado.tiposPorCodigo = new Map(estado.tipos.map((tipo) => [tipo.code, tipo]));
    estado.equipe = pessoas.data || [];
    estado.aba = abaDaUrl();
    montarPagina();
    guardarAbaNaUrl(true);
    root.addEventListener("popstate", () => {
      const alvo = abaDaUrl();
      if (alvo === estado.aba) return;
      estado.aba = alvo;
      renderAba();
      if (estado.aba === "solicitacoes") carregarSolicitacoes();
    });
    const pararNotificacoes = Api.notificacoes.assinar((notificacao) => {
      avisar(texto(notificacao.title) || "Nova solicitação recebida.", "ok");
      notificarNoNavegador(notificacao);
      if (!estado.notificacoes.some((item) => item.id === notificacao.id)) {
        estado.notificacoes.unshift(notificacao);
        estado.notificacoes = estado.notificacoes.slice(0, 50);
        estado.notificacoesTotal += 1;
        estado.notificacoesErro = "";
        desenharNotificacoes();
      }
      if (estado.aba === "solicitacoes") {
        carregarSolicitacoes({ manterPagina: true });
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
