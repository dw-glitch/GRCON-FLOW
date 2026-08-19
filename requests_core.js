/**
 * GRCON — Motor de Consultas e Solicitações
 *
 * Camada sem interface: consulta de documentos nas LDs, protocolos, tipos de
 * solicitação e a classificação da triagem. Fica separada da tela porque é a
 * parte que precisa ser testada sozinha, e porque o mesmo motor atende tanto a
 * consulta rápida quanto a triagem das solicitações.
 *
 * Duas regras atravessam o arquivo inteiro e explicam quase todas as decisões:
 *
 *   1. Nunca inventar. Quando a identificação não é confiável, o resultado diz
 *      "não localizado" ou "requer validação manual" — nunca um palpite.
 *   2. Nunca casar por semelhança. A correspondência usa o código completo e
 *      normalizado (com a regra do nt- do próprio motor de triagem). Título
 *      parecido ou pedaço de código não geram correspondência.
 */
(function (root, factory) {
  // O motor documental é resolvido na hora do uso, não aqui: no navegador este
  // arquivo pode ser avaliado antes de core.js, e capturar a referência agora
  // deixaria C nulo para sempre — a busca devolveria "não localizado" para tudo,
  // silenciosamente, mesmo com o documento na LD.
  const resolveCore = () => root.TriagemCore
    || (typeof module === "object" && module.exports ? require("./core.js") : null);
  const api = factory(resolveCore);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.GrconRequestsCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (resolveCore) {
  "use strict";

  // Açúcar para o corpo do módulo continuar lendo como antes.
  const core = () => resolveCore();

  function text(value) {
    return value === null || value === undefined ? "" : String(value).trim();
  }

  function norm(value) {
    return core() && core().norm ? core().norm(value) : text(value).toUpperCase();
  }

  // ---------------------------------------------------------------------------
  // Tipos de solicitação
  //
  // Ficam no banco e são editáveis pelo usuário. Esta lista é só a semente da
  // primeira carga: nada aqui é obrigatório e nada é fixo no código, senão a
  // área de configuração não teria sentido.
  // ---------------------------------------------------------------------------
  // Os rótulos são os que já aparecem na coluna "Descrição da Solicitação" do
  // Controle de Solicitações, na ordem de frequência real: POSTAGEM NO SIGEM
  // responde por dois terços dos pedidos, ALOCAÇÃO e INCLUSÃO NA LD vêm em
  // seguida. Manter a grafia da planilha evita ter de traduzir na exportação.
  const DEFAULT_REQUEST_TYPES = Object.freeze([
    { code: "POSTAGEM_SIGEM", label: "POSTAGEM NO SIGEM", defaultAction: "Postar no SIGEM", defaultDeadlineDays: 3, defaultPriority: "normal", order: 1 },
    { code: "ALOCACAO", label: "ALOCAÇÃO", defaultAction: "Providenciar a alocação", defaultDeadlineDays: 7, defaultPriority: "alta", order: 2 },
    { code: "INCLUSAO_LD", label: "INCLUSÃO NA LD", defaultAction: "Analisar a inclusão na LD", defaultDeadlineDays: 10, defaultPriority: "normal", order: 3 },
    { code: "INCLUSAO_E_ALOCACAO", label: "INCLUIR NA LD E FAZER ALOCAÇÃO", defaultAction: "Incluir na LD e providenciar a alocação", defaultDeadlineDays: 10, defaultPriority: "alta", order: 4 },
    { code: "IMPRESSAO", label: "IMPRESSÃO", defaultAction: "Imprimir conforme solicitado", defaultDeadlineDays: 2, defaultPriority: "normal", order: 5 },
    { code: "ALTERACAO_TITULO", label: "ALTERAÇÃO DO TITULO", defaultAction: "Conferir o título oficial na LD antes de alterar", defaultDeadlineDays: 5, defaultPriority: "normal", order: 6 },
    { code: "CORRECAO_ALOCACAO", label: "CORREÇÃO DE ALOCAÇÃO", defaultAction: "Corrigir a alocação registrada", defaultDeadlineDays: 5, defaultPriority: "normal", order: 7 },
    { code: "CORRECAO_LD", label: "CORREÇÃO LD", defaultAction: "Corrigir o cadastro na LD", defaultDeadlineDays: 5, defaultPriority: "normal", order: 8 },
    { code: "INCLUSAO_CV", label: "INCLUSÃO DE CV", defaultAction: "Incluir o currículo na LD", defaultDeadlineDays: 5, defaultPriority: "normal", order: 9 },
    { code: "POSTAGEM_E_INCLUSAO", label: "POSTAGEM NO SIGEM / INCLUSÃO NA LD", defaultAction: "Incluir na LD e postar no SIGEM", defaultDeadlineDays: 7, defaultPriority: "normal", order: 10 },
  ]);

  const PRIORITIES = Object.freeze(["baixa", "normal", "alta", "urgente"]);

  const REQUEST_STATUSES = Object.freeze([
    { code: "rascunho", label: "Rascunho", open: true },
    { code: "recebido", label: "Recebido", open: true },
    { code: "em_triagem", label: "Em triagem", open: true },
    { code: "aguardando_info", label: "Aguardando informação", open: true },
    { code: "pendente", label: "Pendente", open: true },
    { code: "em_execucao", label: "Em execução", open: true },
    { code: "aguardando_validacao", label: "Aguardando validação", open: true },
    { code: "concluido", label: "Concluído", open: false },
    { code: "cancelado", label: "Cancelado", open: false },
  ]);

  function normalizeRequestType(raw) {
    const source = raw || {};
    const label = text(source.label);
    if (!label) return null;
    const code = text(source.code).toUpperCase().replace(/[^A-Z0-9_]/g, "_")
      || norm(label).replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
    if (!code) return null;
    const priority = PRIORITIES.includes(text(source.defaultPriority).toLowerCase())
      ? text(source.defaultPriority).toLowerCase()
      : "normal";
    const days = Number(source.defaultDeadlineDays);
    return {
      code,
      label,
      description: text(source.description),
      defaultAction: text(source.defaultAction),
      defaultPriority: priority,
      // Sem prazo padrão é uma resposta válida: nem todo tipo tem prazo.
      defaultDeadlineDays: Number.isFinite(days) && days > 0 ? Math.trunc(days) : null,
      requiredFields: Array.isArray(source.requiredFields) ? source.requiredFields.map(text).filter(Boolean) : [],
      active: source.active === undefined ? true : Boolean(source.active),
      order: Number(source.order) || 0,
    };
  }

  function requestTypeList(saved) {
    const list = (Array.isArray(saved) && saved.length ? saved : DEFAULT_REQUEST_TYPES)
      .map(normalizeRequestType)
      .filter(Boolean);
    return list.sort((a, b) => (a.order - b.order) || a.label.localeCompare(b.label, "pt-BR"));
  }

  // ---------------------------------------------------------------------------
  // Protocolo
  //
  // O protocolo É o número do ITEM da planilha oficial de Controle de
  // Solicitações: um sequencial simples e contínuo, que na planilha em uso vai
  // de 1 a 556 sem falha. Não é composto por número de solicitação nem por ano.
  //
  // A sequência é global da planilha, não reinicia por solicitação: uma
  // solicitação com dez documentos consome dez números seguidos, porque é o
  // item que é acompanhado, concluído e cobrado individualmente.
  // ---------------------------------------------------------------------------
  function protocolFor(itemNumber) {
    const item = Math.trunc(Number(itemNumber));
    return Number.isFinite(item) && item > 0 ? String(item) : "";
  }

  /**
   * Próximo item livre, continuando a sequência da planilha. Recebe os itens
   * que já existem — inclusive os importados do controle oficial — para nunca
   * reaproveitar um número, nem quando alguém apaga um item do meio da lista.
   */
  function nextItemNumber(existingItems) {
    const usados = (existingItems || [])
      .map((item) => Math.trunc(Number(
        item && item.itemNumber !== undefined ? item.itemNumber : item && item.protocol
      )))
      .filter((value) => Number.isFinite(value) && value > 0);
    return usados.length ? Math.max(...usados) + 1 : 1;
  }

  /**
   * Numera uma leva de documentos a partir do próximo item livre, devolvendo
   * cada um já com o seu protocolo.
   */
  function assignItemNumbers(documents, existingItems) {
    let proximo = nextItemNumber(existingItems);
    return (documents || []).map((item) => {
      const numero = proximo;
      proximo += 1;
      return { ...item, itemNumber: numero, protocol: protocolFor(numero) };
    });
  }

  function duplicatedProtocols(items) {
    const contagem = new Map();
    (items || []).forEach((item) => {
      const protocolo = text(item && item.protocol);
      if (!protocolo) return;
      contagem.set(protocolo, (contagem.get(protocolo) || 0) + 1);
    });
    return [...contagem.entries()].filter(([, quantas]) => quantas > 1).map(([protocolo]) => protocolo);
  }

  // ---------------------------------------------------------------------------
  // Entrada de documentos
  // ---------------------------------------------------------------------------

  /**
   * Lê uma lista colada, um documento por linha. Também aceita as colagens que
   * vêm de planilha, em que a linha traz código e título separados por tabulação
   * — nesse caso o que vem depois da primeira tabulação é tratado como o título
   * informado pelo solicitante, e não como parte do código.
   */
  function parseDocumentList(rawText) {
    const linhas = String(rawText || "").split(/\r?\n/);
    const itens = [];
    linhas.forEach((linha, indice) => {
      const conteudo = linha.trim();
      if (!conteudo) return;
      const partes = conteudo.split("\t");
      const documento = text(partes[0]);
      if (!documento) return;
      itens.push({
        document: documento,
        requestedTitle: text(partes.slice(1).join(" ")),
        sourceLine: indice + 1,
      });
    });
    return itens;
  }

  // Extensões que aparecem nos arquivos entregues. A lista é fechada de
  // propósito: cortar "o que vier depois do último ponto" transformaria
  // `LI-5290.00-22313` em `LI-5290`.
  const FILE_EXTENSIONS = /\.(?:pdf|docx?|xlsx?|xlsm|dwg|dgn|pptx?|zip|rar|msg|eml|jpg|jpeg|png|tif|tiff)$/i;

  /**
   * Código do documento a partir do nome do arquivo entregue.
   *
   * Tira o caminho, a extensão e o sufixo de postagem (`_0001`, `_0001_A`) que
   * o SIGEM acrescenta ao arquivo — o que sobra é o código como ele aparece na
   * LD. Nada além disso é adivinhado: se o nome não tiver código nenhum, a
   * resposta é vazia, e a tela pede o código à pessoa.
   */
  function documentFromFileName(fileName) {
    const bruto = text(fileName).split(/[\\/]/).pop();
    if (!bruto) return { document: "", fileName: "", removed: "", changed: false };
    const semExtensao = bruto.replace(FILE_EXTENSIONS, "");
    const semSufixo = semExtensao.replace(/_\d{4}(?:_[0-9A-Za-z]+)?$/, "");
    const documento = text(semSufixo);
    return {
      document: documento,
      fileName: bruto,
      removed: text(semExtensao.slice(documento.length)),
      changed: documento !== bruto,
    };
  }

  /** Uma entrada de solicitação por arquivo anexado, sem repetir código. */
  function documentsFromFiles(files) {
    const entradas = [];
    (files || []).forEach((file) => {
      const nome = typeof file === "string" ? file : text(file && file.name);
      const lido = documentFromFileName(nome);
      if (!lido.document) return;
      entradas.push({ document: lido.document, requestedTitle: "", fileName: lido.fileName, source: "arquivo anexado" });
    });
    return entradas;
  }

  /**
   * Remove repetições pelo código normalizado, preservando a primeira ocorrência
   * e o título informado quando a primeira linha veio sem ele. Devolve também o
   * que saiu, para a tela poder mostrar o que foi descartado em vez de sumir com
   * as linhas silenciosamente.
   */
  function dedupeDocuments(items) {
    const vistos = new Map();
    const mantidos = [];
    const removidos = [];
    (items || []).forEach((item) => {
      const chave = core() && core().key ? core().key(item && item.document) : norm(item && item.document);
      if (!chave) return;
      if (vistos.has(chave)) {
        const anterior = vistos.get(chave);
        if (!anterior.requestedTitle && item.requestedTitle) anterior.requestedTitle = item.requestedTitle;
        removidos.push(item);
        return;
      }
      const copia = { ...item };
      vistos.set(chave, copia);
      mantidos.push(copia);
    });
    return { items: mantidos, removed: removidos };
  }

  // ---------------------------------------------------------------------------
  // Consulta nas LDs
  // ---------------------------------------------------------------------------

  function occurrenceFrom(record) {
    // A situação da alocação é lida da linha inteira — status, número de ALOC e
    // a existência da coluna na aba —, a mesma leitura da Triagem. Ler só a
    // célula de confirmação devolvia "não informado" para linha que traz o
    // número da ALOC e para aba que nem rastreia alocação.
    const estado = core() && core().allocationEvidenceState
      ? core().allocationEvidenceState(record)
      : core() && core().allocationState
        ? core().allocationState(record.allocationStatus)
        : { kind: "empty", label: "Não informado" };
    return {
      document: text(record.document),
      // O título sai exatamente como está na LD: sem maiúsculas forçadas, sem
      // mexer em acento, símbolo ou pontuação.
      title: text(record.title),
      allocationStatus: text(record.allocationStatus),
      allocationKind: estado.kind,
      allocationLabel: estado.label,
      allocationEvidence: text(estado.evidence),
      allocation: text(record.allocation),
      lastGrdt: text(record.grdt),
      sigemStatus: text(record.sigemStatus),
      revision: text(record.revision),
      ld: text(record.source),
      ldVersion: text(record.ldVersion),
      sheet: text(record.sheet),
      row: Number(record.row) || null,
      sourceTimestamp: Number(record.sourceTimestamp) || 0,
    };
  }

  /**
   * Escolhe a ocorrência considerada correta quando o documento aparece em mais
   * de uma LD, e explica a regra aplicada. A escolha nunca combina campos de
   * LDs diferentes: uma ocorrência inteira é eleita, e as outras seguem
   * visíveis para conferência.
   */
  /** Ocorrências que se contradizem quanto à alocação do mesmo documento. */
  function allocationConflict(occurrences) {
    const tipos = new Set((occurrences || []).map((item) => text(item && item.allocationKind)));
    return tipos.has("allocated") && tipos.has("not_allocated");
  }

  function chooseOccurrence(occurrences) {
    if (!occurrences.length) return { chosen: null, rule: "", conflicting: false };
    if (occurrences.length === 1) {
      return { chosen: occurrences[0], rule: "Única ocorrência localizada.", conflicting: false };
    }
    // Divergência é sobre o que a consulta responde. Duas LDs com o mesmo
    // conteúdo não são conflito, são repetição.
    const assinatura = (item) => [item.title, item.allocationKind, item.lastGrdt, item.sigemStatus, item.revision].join("|");
    const divergem = new Set(occurrences.map(assinatura)).size > 1;

    const ordenadas = [...occurrences].sort((a, b) => b.sourceTimestamp - a.sourceTimestamp);
    const maisRecente = ordenadas[0];
    const empatadas = ordenadas.filter((item) => item.sourceTimestamp === maisRecente.sourceTimestamp);

    if (!divergem) {
      return { chosen: maisRecente, rule: `Localizado em ${occurrences.length} LDs com a mesma informação.`, conflicting: false };
    }
    if (empatadas.length > 1) {
      // Sem critério para desempatar, quem decide é a pessoa. Quando as linhas
      // vêm do mesmo arquivo, dizer "as LDs divergem" mandava procurar uma
      // segunda LD que não existe: a divergência está dentro da mesma planilha.
      const arquivos = [...new Set(empatadas.map((item) => text(item.ld)).filter(Boolean))];
      const onde = arquivos.length > 1
        ? `As LDs divergem e têm a mesma data de envio (${arquivos.join(", ")}).`
        : `A LD ${arquivos[0] || "informada"} traz linhas divergentes para o mesmo documento (${empatadas.map((item) => `${item.sheet || "aba"} · linha ${item.row || "?"}`).join(", ")}).`;
      return { chosen: null, rule: `${onde} Escolha qual vale.`, conflicting: true };
    }
    return {
      chosen: maisRecente,
      rule: `As LDs divergem. Considerada a mais recente: ${maisRecente.ld}. Confirme ou troque.`,
      conflicting: true,
    };
  }

  /**
   * Consulta um documento no índice montado a partir de todas as LDs anexadas.
   *
   * O índice do GRCON já resolve a regra do nt- (documentos ET) e uma
   * aproximação controlada do TAG que só vale quando existe uma única
   * correspondência. Ambas rebaixam a confiança do resultado, porque o código
   * informado não era exatamente o da LD.
   */
  function lookupDocument(document, index, options) {
    const settings = options || {};
    const informado = text(document);
    const base = {
      document: informado,
      requestedTitle: text(settings.requestedTitle),
      found: false,
      confidence: "nenhuma",
      needsManualValidation: true,
      occurrences: [],
      chosen: null,
      rule: "",
      conflicting: false,
      lookup: null,
      message: "Não localizado nas LDs anexadas.",
    };
    if (!informado || !index || !core()) return base;

    const matches = core().matchDocuments(informado, index, settings.hintedSheet) || [];
    const primeiro = matches[0] || null;
    const lookup = core().documentLookup ? core().documentLookup(informado, matches.length === 1 ? primeiro : null, matches) : null;

    if (!primeiro) {
      return { ...base, lookup, message: lookup && lookup.message ? lookup.message : base.message };
    }

    // Todas as linhas do grupo: é isto que responde "em quais LDs foi achado".
    const registros = (primeiro.group && primeiro.group.records) || [];
    const occurrences = registros.map(occurrenceFrom);
    const { chosen, rule, conflicting } = chooseOccurrence(occurrences);

    const porVariante = Boolean(primeiro.matchKind && primeiro.matchKind !== "exact");
    const confidence = conflicting || !chosen
      ? "baixa"
      : porVariante
        ? "media"
        : occurrences.length > 1 ? "media" : "alta";

    return {
      document: informado,
      requestedTitle: text(settings.requestedTitle),
      found: true,
      confidence,
      // Só a confiança alta dispensa conferência; qualquer variação de código ou
      // divergência entre LDs volta para a pessoa decidir.
      needsManualValidation: confidence !== "alta",
      occurrences,
      chosen,
      rule,
      conflicting,
      matchKind: primeiro.matchKind || "exact",
      ldDocument: text(primeiro.document),
      lookup,
      message: lookup && lookup.message ? lookup.message : "",
    };
  }

  function lookupDocuments(documents, index, options) {
    return (documents || []).map((item) => {
      const documento = typeof item === "string" ? item : text(item && item.document);
      const titulo = typeof item === "string" ? "" : text(item && item.requestedTitle);
      return lookupDocument(documento, index, { ...(options || {}), requestedTitle: titulo });
    });
  }

  /**
   * As seis colunas que a consulta rápida responde, já prontas para a tela e
   * para o Excel. Quando não há ocorrência eleita, os campos ficam vazios em vez
   * de receberem o valor de uma LD qualquer.
   */
  /**
   * Como a alocação é dita em todas as saídas deste módulo. Cada situação tem a
   * sua frase: alocado por status, alocado pelo número da ALOC, não alocado,
   * aba sem coluna de alocação e coluna vazia são fatos diferentes.
   */
  function allocationAnswer(occurrence) {
    const item = occurrence || null;
    if (!item) return "";
    if (item.allocationKind === "conflict") return "CONFLITO — a LD registra ALOCADO e NÃO ALOCADO";
    if (item.allocationKind === "allocated") {
      return item.allocationEvidence === "number" && item.allocation
        ? `SIM — alocação evidenciada pelo número ${item.allocation}`
        : "SIM — Alocado";
    }
    if (item.allocationKind === "not_allocated") return "NÃO — Não alocado";
    if (item.allocationKind === "not_tracked") return "NÃO APURADO — a LD não rastreia alocação nesta aba";
    if (item.allocationKind === "blank" || item.allocationKind === "empty") return "NÃO INFORMADO — campo de confirmação vazio na LD";
    return `REVISAR — ${item.allocationLabel}`;
  }

  function consultationRow(resultado) {
    const escolhida = resultado && resultado.chosen;
    const todas = (resultado && resultado.occurrences) || [];
    return {
      document: text(resultado && resultado.document),
      title: escolhida ? escolhida.title : "",
      // Sem ocorrência eleita por divergência de alocação, a resposta é o
      // conflito — deixar em branco fazia a consulta parecer que não apurou.
      allocated: escolhida
        ? allocationAnswer(escolhida)
        : allocationConflict(todas)
          ? "CONFLITO — a LD registra ALOCADO e NÃO ALOCADO"
          : "",
      allocationKind: escolhida ? text(escolhida.allocationKind) : (allocationConflict(todas) ? "conflict" : ""),
      allocation: escolhida ? escolhida.allocation : "",
      lastGrdt: escolhida ? escolhida.lastGrdt : "",
      sigemStatus: escolhida ? escolhida.sigemStatus : "",
      ld: escolhida ? escolhida.ld : "",
      allLds: [...new Set(todas.map((item) => item.ld).filter(Boolean))].join(" | "),
      occurrenceCount: todas.length,
      confidence: resultado ? resultado.confidence : "nenhuma",
      needsManualValidation: Boolean(resultado && resultado.needsManualValidation),
      rule: text(resultado && resultado.rule),
      situation: !resultado || !resultado.found
        ? "Não localizado"
        : resultado.conflicting || !escolhida
          ? "Requer validação manual"
          : "Localizado",
    };
  }

  // ---------------------------------------------------------------------------
  // Histórico do próprio GRCON
  //
  // A consulta responde o que a LD diz sobre o documento. Falta a outra metade
  // da pergunta que se faz o dia inteiro: este documento já foi emitido por
  // nós? Em que eGRDT e quando? O histórico de eGRDTs geradas fica no
  // navegador; aqui só se dá forma ao que ele devolve.
  //
  // A regra de sempre continua: sem registro, a resposta é "não emitido", e não
  // um silêncio que se confunde com "não consultei".
  // ---------------------------------------------------------------------------

  /** Data ISO do histórico no formato de leitura (dd/mm/aaaa). */
  function formatDateBR(value) {
    const raw = text(value);
    if (!raw) return "";
    const data = new Date(raw);
    if (Number.isNaN(data.getTime())) {
      const simples = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
      return simples ? `${simples[3]}/${simples[2]}/${simples[1]}` : raw;
    }
    return data.toLocaleDateString("pt-BR");
  }

  /**
   * Resposta do histórico para um documento, pronta para a tela e para o Excel.
   *
   * `entries` são os registros do histórico local ({ egrdtNumber, generatedAt }),
   * da emissão mais recente para a mais antiga.
   */
  function issuedHistory(entries) {
    const lista = (entries || [])
      .map((item) => ({ egrdt: text(item && item.egrdtNumber), date: formatDateBR(item && item.generatedAt) }))
      .filter((item) => item.egrdt);
    if (!lista.length) {
      return { issued: false, count: 0, egrdt: "", date: "", all: [], label: "Não emitido pelo GRCON", cell: "Não emitido" };
    }
    const [maisRecente] = lista;
    return {
      issued: true,
      count: lista.length,
      egrdt: maisRecente.egrdt,
      date: maisRecente.date,
      all: lista,
      label: `${maisRecente.egrdt}${maisRecente.date ? ` · ${maisRecente.date}` : ""}${lista.length > 1 ? ` · +${lista.length - 1} anterior(es)` : ""}`,
      // No Excel a data fica na linha de baixo, dentro da mesma célula: é assim
      // que se lê o número sem perder de vista quando ele saiu.
      cell: lista.map((item) => (item.date ? `${item.egrdt}\n${item.date}` : item.egrdt)).join("\n"),
    };
  }

  /** Os campos que a linha da consulta ganha com o histórico. */
  function issuedColumns(entries) {
    const historico = issuedHistory(entries);
    return {
      issued: historico.issued ? "SIM" : "NÃO",
      issuedEgrdt: historico.egrdt,
      issuedAt: historico.date,
      issuedCount: historico.count,
      issuedCell: historico.cell,
      issuedLabel: historico.label,
      issuedAll: historico.all,
    };
  }

  // ---------------------------------------------------------------------------
  // Linha do Controle de Solicitações
  // ---------------------------------------------------------------------------

  /**
   * Converte um item da solicitação numa linha da planilha oficial.
   *
   * Preenche só o que a pessoa informou. Tudo o que depende de etapa posterior
   * — retorno da fiscal, datas de submissão, disponibilização no PW — fica em
   * branco para a saída marcar como "na", e é preenchido na própria tabela
   * quando acontecer. Inventar aqui seria pior do que deixar em branco.
   */
  function controlRowFromItem(input) {
    const dados = input || {};
    const cabecalho = dados.header || {};

    return {
      item: text(dados.protocol),
      owner: text(cabecalho.owner),
      receivedAt: text(cabecalho.receivedAt),
      requester: text(cabecalho.requester),
      documentFamily: text(cabecalho.documentFamily),
      requestType: text(cabecalho.requestType),
      origin: text(cabecalho.origin),
      emailBody: text(cabecalho.emailBody),
      document: text(dados.document),
      documentPath: text(cabecalho.documentPath),
      // Quem responde se precisa incluir na LD é a pessoa: o GRCON não
      // consultou LD nenhuma aqui e não tem como saber.
      needsLdInclusion: "",
      ldVersion: "",
      ldApprovedAt: "",
      allocation: "",
      reference: "",
      allocSentAt: "",
      fiscal1ReturnedAt: "",
      fiscal1Answer: "",
      fiscal2ReturnedAt: "",
      sigemOwner: "",
      sigemStatus: "",
      sigemSubmittedAt: "",
      observations: "",
      pwN1710: "",
      overallStatus: text(cabecalho.overallStatus) || "Recebida",
      statusDate: text(cabecalho.receivedAt),
    };
  }

  /**
   * Transforma os documentos consultados em linhas do controle, numerando os
   * itens a partir do próximo livre. É o caminho que evita redigitar o que o
   * GRCON já descobriu.
   */
  /**
   * Linhas de solicitação sem consulta à LD.
   *
   * Nem toda solicitação nasce de uma triagem: chega um pedido por e-mail e a
   * pessoa precisa registrar e colar na planilha. Aqui não há classificação
   * nenhuma — sem LD não há o que classificar, e inventar uma situação seria
   * pior do que deixar em branco para ela preencher.
   */
  function buildManualControlRows(entries, header, existingItems) {
    const numerados = assignItemNumbers(entries || [], existingItems);
    return numerados.map((entrada) => ({
      ...controlRowFromItem({
        protocol: entrada.protocol,
        document: entrada.document,
        header: header || {},
      }),
      // O título informado não vira "título oficial": ninguém conferiu na LD.
      _requestedTitle: text(entrada.requestedTitle),
      _itemNumber: entrada.itemNumber,
      _fileName: text(entrada.fileName),
      _source: text(entrada.source),
      _classification: "",
      _needsManualValidation: false,
      _manual: true,
    }));
  }

  /**
   * O que a LD responde sobre um documento da solicitação: o número da alocação
   * e se ele está alocado ou não.
   *
   * Consultar é opcional — quem não anexa LD continua preenchendo à mão. Quando
   * a LD é consultada e o documento não aparece nela, a resposta é essa mesma, e
   * não um palpite: os campos ficam vazios e a linha registra que foi procurado.
   */
  function ldFactsFor(document, index, options) {
    const settings = options || {};
    if (!index) {
      return { consulted: false, found: false, allocation: "", allocated: "", allocationKind: "", sigemStatus: "", ldVersion: "", title: "", ld: "", note: "" };
    }
    const resultado = lookupDocument(document, index, settings);
    const linha = consultationRow(resultado);
    const escolhida = resultado.chosen;
    if (!resultado.found || !escolhida) {
      return {
        consulted: true,
        found: false,
        allocation: "",
        allocated: "",
        allocationKind: "",
        sigemStatus: "",
        ldVersion: "",
        title: "",
        ld: "",
        needsLdInclusion: "sim",
        note: resultado.found
          ? `Consultado na LD: ${linha.situation}. ${text(resultado.rule)}`.trim()
          : "Consultado na LD: não localizado.",
      };
    }
    return {
      consulted: true,
      found: true,
      allocation: text(escolhida.allocation),
      allocated: linha.allocated,
      allocationKind: text(escolhida.allocationKind),
      sigemStatus: text(escolhida.sigemStatus),
      ldVersion: text(escolhida.ldVersion),
      title: text(escolhida.title),
      ld: text(escolhida.ld),
      // Documento localizado na LD não precisa de inclusão; "não" aqui é o que
      // a LD respondeu, não uma suposição.
      needsLdInclusion: "não",
      note: `Consultado na LD ${text(escolhida.ld)}${escolhida.sheet ? ` · aba ${escolhida.sheet}` : ""}${escolhida.row ? ` · linha ${escolhida.row}` : ""}.`,
      needsManualValidation: Boolean(resultado.needsManualValidation),
    };
  }

  /**
   * Aplica na linha do controle o que a LD respondeu, sem apagar o que a pessoa
   * já digitou: campo preenchido à mão continua valendo.
   */
  function applyLdFacts(row, facts) {
    const linha = { ...(row || {}) };
    const dados = facts || {};
    if (!dados.consulted) return linha;
    if (dados.allocation && !text(linha.allocation)) linha.allocation = dados.allocation;
    if (dados.sigemStatus && !text(linha.sigemStatus)) linha.sigemStatus = dados.sigemStatus;
    if (dados.ldVersion && !text(linha.ldVersion)) linha.ldVersion = dados.ldVersion;
    if (dados.needsLdInclusion && !text(linha.needsLdInclusion)) linha.needsLdInclusion = dados.needsLdInclusion;
    linha._allocated = text(dados.allocated);
    linha._allocationKind = text(dados.allocationKind);
    linha._ldTitle = text(dados.title);
    linha._ld = text(dados.ld);
    linha._ldConsulted = true;
    linha._ldFound = Boolean(dados.found);
    linha._needsManualValidation = Boolean(dados.needsManualValidation);
    const nota = text(dados.note);
    if (nota && !text(linha.observations).includes(nota)) {
      linha.observations = [text(linha.observations), nota].filter(Boolean).join(" ");
    }
    return linha;
  }

  return Object.freeze({
    controlRowFromItem,
    buildManualControlRows,
    DEFAULT_REQUEST_TYPES,
    PRIORITIES,
    REQUEST_STATUSES,
    normalizeRequestType,
    requestTypeList,
    protocolFor,
    nextItemNumber,
    assignItemNumbers,
    duplicatedProtocols,
    parseDocumentList,
    documentFromFileName,
    documentsFromFiles,
    dedupeDocuments,
    lookupDocument,
    lookupDocuments,
    consultationRow,
    allocationConflict,
    formatDateBR,
    issuedHistory,
    issuedColumns,
    allocationAnswer,
    ldFactsFor,
    applyLdFacts,
    chooseOccurrence,
  });
});
