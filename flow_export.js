/**
 * GRCON Flow — exportação para Excel.
 *
 * O Excel deixou de ser onde o trabalho acontece e passou a ser uma saída do
 * sistema: primeiro se trabalha no Flow, depois se exporta.
 *
 * A primeira aba reproduz o Controle de Solicitações — as 26 colunas na ordem
 * e com a grafia da planilha oficial —, para colar sob o que já existe sem
 * rearrumar coluna nenhuma. O que o Flow sabe além disso (protocolo, tipo,
 * classificação da triagem, LD consultada) vai para uma segunda aba, em vez de
 * deformar a primeira.
 */
(function (root) {
  "use strict";

  const Report = () => root.GrconRequestsReport;

  function texto(valor) {
    return valor === null || valor === undefined ? "" : String(valor).trim();
  }

  function dataBR(valor) {
    if (!valor) return "";
    const d = new Date(valor);
    return Number.isNaN(d.getTime()) ? texto(valor) : d.toLocaleDateString("pt-BR");
  }

  const STATUS_LEGIVEL = {
    rascunho: "Rascunho", recebido: "Recebida", em_triagem: "Em triagem",
    aguardando_info: "Aguardando informação", pendente: "Pendente",
    em_execucao: "Em execução", aguardando_validacao: "Aguardando validação",
    concluido: "Concluída", cancelado: "Cancelada",
  };

  const CLASSIFICACAO_LEGIVEL = {
    PRONTO: "Pronto", VALIDAR: "Requer validação",
    NAO_LOCALIZADO: "Não localizado nas LDs", ACAO_NECESSARIA: "Sem alocação identificada",
    IDENTIFICACAO_PENDENTE: "Código a identificar",
    POSSIVEIS_CORRESPONDENCIAS: "Possíveis correspondências",
    TRIAGEM_NAO_APLICAVEL: "Triagem não aplicável",
  };

  /**
   * Uma linha da view vira uma linha do Controle.
   *
   * Campo que o Flow não apurou fica vazio e a planilha o escreve como "na",
   * que é a convenção da própria planilha para "não se aplica". Preencher por
   * suposição seria pior do que deixar em branco.
   */
  function linhaDoControle(registro, indice) {
    const semCodigo = !texto(registro.document);
    const observacoes = [
      texto(registro.observations),
      semCodigo && texto(registro.requested_title)
        ? `Sem código informado. Título indicado: ${texto(registro.requested_title)}.`
        : "",
      texto(registro.triage_rule),
      texto(registro.item_answer) ? `Resposta: ${texto(registro.item_answer)}` : "",
    ].filter(Boolean).join(" ");

    // "Precisa entrar na LD?" só é respondido quando a triagem de fato
    // consultou as bases. Sem consulta, quem responde é a pessoa.
    const inclusao = registro.classification === "NAO_LOCALIZADO" ? "sim"
      : ["PRONTO", "ACAO_NECESSARIA", "VALIDAR"].includes(registro.classification) ? "não"
      : "";

    return {
      item: String(indice + 1),
      owner: texto(registro.owner_name),
      receivedAt: dataBR(registro.received_at),
      requester: [texto(registro.requester_name), texto(registro.requester_area)].filter(Boolean).join(" / "),
      documentFamily: texto(registro.discipline),
      requestType: texto(registro.type_label),
      origin: "GRCON FLOW",
      emailBody: texto(registro.description) || texto(registro.summary),
      document: texto(registro.document),
      documentPath: "",
      needsLdInclusion: inclusao,
      ldVersion: texto(registro.ld_version_label),
      ldApprovedAt: "",
      allocation: texto(registro.allocation),
      reference: texto(registro.ld_name),
      allocSentAt: "",
      fiscal1ReturnedAt: "",
      fiscal1Answer: "",
      fiscal2ReturnedAt: "",
      sigemOwner: "",
      sigemStatus: texto(registro.sigem_status),
      sigemSubmittedAt: "",
      observations: observacoes,
      pwN1710: "",
      overallStatus: STATUS_LEGIVEL[registro.request_status] || texto(registro.request_status),
      statusDate: dataBR(registro.item_updated_at),
    };
  }

  const COLUNAS_FLOW = [
    { header: "PROTOCOLO", chave: (r) => texto(r.protocol), width: 20 },
    { header: "ITEM DA SOLICITAÇÃO", chave: (r) => String(r.item_number || ""), width: 12 },
    { header: "TIPO DE SOLICITAÇÃO", chave: (r) => texto(r.type_label), width: 28 },
    { header: "SOLICITANTE", chave: (r) => texto(r.requester_name), width: 24 },
    { header: "ÁREA", chave: (r) => texto(r.requester_area), width: 20 },
    { header: "CONTATO", chave: (r) => texto(r.requester_contact), width: 24 },
    { header: "DOCUMENTO", chave: (r) => texto(r.document), width: 42 },
    { header: "TÍTULO INFORMADO", chave: (r) => texto(r.requested_title), width: 42 },
    { header: "TÍTULO NA LD", chave: (r) => texto(r.official_title), width: 42 },
    { header: "REFERÊNCIA INFORMADA", chave: (r) => texto(r.reference), width: 28 },
    { header: "CLASSIFICAÇÃO DA TRIAGEM", chave: (r) => CLASSIFICACAO_LEGIVEL[r.classification] || texto(r.classification), width: 26 },
    { header: "ALOCAÇÃO", chave: (r) => texto(r.allocation), width: 24 },
    { header: "SITUAÇÃO DA ALOCAÇÃO", chave: (r) => texto(r.allocation_status), width: 24 },
    { header: "REVISÃO", chave: (r) => texto(r.revision), width: 10 },
    { header: "ÚLTIMA GRDT", chave: (r) => texto(r.last_grdt), width: 22 },
    { header: "STATUS NO SIGEM", chave: (r) => texto(r.sigem_status), width: 20 },
    { header: "LD CONSIDERADA", chave: (r) => texto(r.ld_name), width: 20 },
    { header: "VERSÃO DA LD", chave: (r) => texto(r.ld_version_label), width: 16 },
    { header: "LDs EM QUE APARECEU", chave: (r) => texto(r.all_lds), width: 26 },
    { header: "COMO O FLOW CHEGOU A ISSO", chave: (r) => texto(r.triage_rule), width: 56 },
    { header: "RESPONSÁVEL", chave: (r) => texto(r.owner_name), width: 22 },
    { header: "STATUS DO ITEM", chave: (r) => STATUS_LEGIVEL[r.item_status] || texto(r.item_status), width: 20 },
    { header: "STATUS DA SOLICITAÇÃO", chave: (r) => STATUS_LEGIVEL[r.request_status] || texto(r.request_status), width: 20 },
    { header: "RESPOSTA", chave: (r) => texto(r.item_answer) || texto(r.request_answer), width: 46 },
    { header: "PRAZO", chave: (r) => dataBR(r.item_due_at || r.request_due_at), width: 14 },
    { header: "RECEBIDA EM", chave: (r) => dataBR(r.received_at), width: 16 },
    { header: "TRIADA EM", chave: (r) => dataBR(r.triaged_at), width: 16 },
  ];

  const AZUL = "FF153A5C";

  function escreverAbaFlow(aba, registros) {
    aba.columns = COLUNAS_FLOW.map((coluna) => ({ width: coluna.width }));
    const cabecalho = aba.getRow(1);
    COLUNAS_FLOW.forEach((coluna, indice) => {
      const celula = cabecalho.getCell(indice + 1);
      celula.value = coluna.header;
      celula.font = { name: "Aptos", size: 9, bold: true, color: { argb: "FFFFFFFF" } };
      celula.fill = { type: "pattern", pattern: "solid", fgColor: { argb: AZUL } };
      celula.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
    });
    cabecalho.height = 30;

    registros.forEach((registro, indice) => {
      const linha = aba.getRow(indice + 2);
      COLUNAS_FLOW.forEach((coluna, coluna_indice) => {
        const celula = linha.getCell(coluna_indice + 1);
        const valor = coluna.chave(registro);
        celula.value = valor === "" ? null : valor;
        celula.font = { name: "Aptos", size: 9 };
        celula.alignment = { vertical: "top", wrapText: true };
        if (indice % 2) celula.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
      });
    });

    aba.autoFilter = { from: { row: 1, column: 1 }, to: { row: registros.length + 1, column: COLUNAS_FLOW.length } };
    aba.views = [{ state: "frozen", ySplit: 1, showGridLines: false }];
  }

  /**
   * Gera o arquivo. Nada é lido da tela: as linhas vêm do banco já filtradas,
   * para que o que sai no Excel seja o que está gravado, e não o que por acaso
   * estava carregado na página.
   */
  async function gerar(registros, { nome = "GRCON_FLOW", descricaoFiltro = "todos os registros" } = {}) {
    const ExcelJS = root.ExcelJS;
    const relatorio = Report();
    if (!ExcelJS || !relatorio) throw new Error("Gerador de planilha indisponível. Recarregue a página.");
    if (!registros.length) throw new Error("Nenhuma linha para exportar com os filtros atuais.");

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "GRCON Flow";
    workbook.company = "CONSAG Engenharia";
    workbook.title = "Controle de Solicitações";

    const linhas = registros.map(linhaDoControle);

    const abaControle = workbook.addWorksheet("Controle de Solicitações", {
      properties: { defaultRowHeight: 18 },
      views: [{ showGridLines: false }],
    });
    relatorio.writeControlSheet(abaControle, linhas, {
      title: "CONTROLE DE SOLICITAÇÕES",
      metadata: `${linhas.length.toLocaleString("pt-BR")} item(ns) · ${descricaoFiltro} · gerado pelo GRCON Flow em ${new Date().toLocaleString("pt-BR")}`,
    });

    const abaFlow = workbook.addWorksheet("Detalhe do Flow", { views: [{ showGridLines: false }] });
    escreverAbaFlow(abaFlow, registros);

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const carimbo = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    link.href = url;
    link.download = `${nome}_${carimbo}.xlsx`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    return linhas.length;
  }

  /** Linhas por tabulação, no padrão das 26 colunas, para colar direto. */
  function copiar(registros, comCabecalho) {
    const relatorio = Report();
    if (!relatorio) throw new Error("Gerador indisponível.");
    return relatorio.controlClipboardText(registros.map(linhaDoControle), Boolean(comCabecalho));
  }

  root.FlowExport = Object.freeze({ gerar, copiar, linhaDoControle, COLUNAS_FLOW });
})(window);
