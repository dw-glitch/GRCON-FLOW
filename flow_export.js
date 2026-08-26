/**
 * GRCON Flow — exportação do painel para Excel.
 *
 * A primeira aba é o espelho visual do painel. A segunda detalha os itens e a
 * triagem. A terceira preserva o Controle de Solicitações oficial, com as 26
 * colunas legadas, para que a operação continue compatível com o processo já
 * usado pela Qualidade.
 */
(function (root) {
  "use strict";

  const Report = () => root.GrconRequestsReport;
  const AZUL = "FF153A5C";
  const AZUL_CLARO = "FF24689A";
  const BORDA = "FFD7E1E7";
  const TEXTO = "FF263E52";
  const TEXTO_SUAVE = "FF607381";

  function texto(valor) {
    return valor === null || valor === undefined ? "" : String(valor).trim();
  }

  function dataBR(valor) {
    if (!valor) return "";
    const origem = texto(valor);
    // Datas sem hora são interpretadas no fuso local. Caso contrário, um prazo
    // 2026-08-30 pode aparecer como 29/08 em computadores a oeste de UTC.
    const d = /^\d{4}-\d{2}-\d{2}$/.test(origem) ? new Date(`${origem}T00:00:00`) : new Date(origem);
    return Number.isNaN(d.getTime()) ? texto(valor) : d.toLocaleDateString("pt-BR");
  }

  const STATUS_LEGIVEL = Object.freeze({
    rascunho: "Rascunho", recebido: "Recebida", em_triagem: "Em triagem",
    identificacao_pendente: "Identificação pendente",
    aguardando_info: "Aguardando informação", pendente: "Pendente",
    em_execucao: "Em execução", aguardando_validacao: "Aguardando validação",
    concluido: "Concluída", cancelado: "Cancelada",
  });

  const CLASSIFICACAO_LEGIVEL = Object.freeze({
    PRONTO: "Pronto", VALIDAR: "Requer validação",
    NAO_LOCALIZADO: "Não localizado nas LDs", ACAO_NECESSARIA: "Sem alocação identificada",
    IDENTIFICACAO_PENDENTE: "Código a identificar",
    POSSIVEIS_CORRESPONDENCIAS: "Possíveis correspondências",
    TRIAGEM_NAO_APLICAVEL: "Triagem não aplicável",
  });

  const ETAPA_LEGIVEL = Object.freeze({
    pendente: "Pendente", em_andamento: "Em andamento",
    concluido: "Concluída", nao_aplicavel: "Não aplicável",
  });

  const ACAO_LEGIVEL = Object.freeze({
    IDENTIFICAR_CODIGO: "Identificar código", INCLUIR_LD: "Incluir na LD",
    ANEXAR_PDF_EXCEL: "Receber PDF + Excel (N-1710)", ALOCAR: "Fazer GRDT / alocação",
    POSTAR_SIGEM: "Postar no SIGEM", CONCLUIDO: "Concluído",
  });

  // Os mesmos títulos exibidos na tabela do painel. Esta lista é exportada
  // também para os testes, impedindo que tela e planilha se afastem em silêncio.
  //
  // A prioridade vem logo depois do protocolo porque é o que mais muda a ordem
  // de leitura da linha. Na planilha ela precisa ser coluna: a faixa vermelha
  // que o painel desenha não sobrevive a um arquivo do Excel.
  // Vazio para o que não tem resposta — a solicitação sem triagem e o tipo que
  // não consulta LD. Uma coluna que escreve "não aplicável" em toda linha de
  // Impressão gasta a atenção de quem procura as que importam.
  const ORIGEM_LEGIVEL = Object.freeze({
    novo: "NOVO",
    previsto: "JÁ PREVISTO",
    misto: "MISTO",
    a_confirmar: "A CONFIRMAR",
    nao_aplicavel: "",
  });

  const COLUNAS_PAINEL = Object.freeze([
    { header: "PROTOCOLO", key: "protocol", width: 21 },
    { header: "PRIORIDADE", key: "priority", width: 14 },
    { header: "TIPO", key: "type", width: 31 },
    { header: "ORIGEM", key: "origin", width: 16 },
    { header: "SOLICITANTE", key: "requester", width: 28 },
    { header: "RECEBIDA", key: "received", width: 15 },
    { header: "RESPONSÁVEL", key: "owner", width: 24 },
    { header: "PROGRESSO", key: "progress", width: 15 },
    { header: "STATUS", key: "status", width: 23 },
    { header: "PRAZO", key: "due", width: 18 },
  ]);

  // A ficha usa colunas próprias por tipo. A aba de itens reúne o catálogo
  // completo para que nenhum dado desapareça quando há tipos diferentes no
  // mesmo arquivo.
  // "normal" some da planilha; o resto aparece por extenso.
  const PRIORIDADE_LEGIVEL = Object.freeze({
    baixa: "Baixa", normal: "", alta: "Alta", urgente: "URGENTE",
  });

  const COLUNAS_ITENS = Object.freeze([
    { header: "PROTOCOLO", key: "protocol", width: 21, value: (r) => texto(r.protocol) },
    { header: "ITEM", key: "item_number", width: 9, value: (r) => Number(r.item_number) || "" },
    { header: "TIPO", key: "type_label", width: 30, value: (r) => texto(r.type_label) },
    { header: "DOCUMENTO", key: "document", width: 43, value: (r) => texto(r.document) },
    { header: "TÍTULO INFORMADO", key: "requested_title", width: 40, value: (r) => texto(r.requested_title) },
    { header: "TÍTULO NA LD", key: "official_title", width: 42, value: (r) => texto(r.official_title) },
    { header: "REFERÊNCIA", key: "reference", width: 26, value: (r) => texto(r.reference) },
    { header: "CLASSIFICAÇÃO", key: "classification", width: 25, value: (r) => CLASSIFICACAO_LEGIVEL[r.classification] || texto(r.classification) },
    // Qual norma rege o código. Fica ao lado da classificação porque as duas
    // dizem o que fazer com o item; vai como sigla, que é o vocabulário do
    // controle em papel do cliente.
    { header: "NORMA", key: "norm_family", width: 12, value: (r) => texto(r.norm_family) },
    { header: "ALOCAÇÃO", key: "allocation", width: 25, value: (r) => texto(r.allocation) },
    { header: "SITUAÇÃO DA ALOCAÇÃO", key: "allocation_status", width: 23, value: (r) => texto(r.allocation_status) },
    { header: "STATUS NO SIGEM", key: "sigem_status", width: 21, value: (r) => texto(r.sigem_status) },
    { header: "PRÓXIMA AÇÃO", key: "internal_next_action", width: 26, value: (r) => ACAO_LEGIVEL[r.internal_next_action] || texto(r.internal_next_action) },
    { header: "ARQUIVOS LI/MC N-1710", key: "n1710_files", width: 24, value: (r) => {
      if (!r.requires_pdf_excel_pair) return "Não aplicável";
      if (r.pdf_attachment_ready && r.excel_attachment_ready) return "PDF + Excel recebidos";
      return `Pendente: ${[!r.pdf_attachment_ready ? "PDF" : "", !r.excel_attachment_ready ? "Excel" : ""].filter(Boolean).join(" + ")}`;
    } },
    { header: "ETAPA · CÓDIGO", key: "code_stage", width: 18, value: (r) => ETAPA_LEGIVEL[r.code_stage] || texto(r.code_stage) },
    { header: "ETAPA · LD", key: "ld_stage", width: 18, value: (r) => ETAPA_LEGIVEL[r.ld_stage] || texto(r.ld_stage) },
    { header: "ETAPA · ALOCAÇÃO", key: "allocation_stage", width: 20, value: (r) => ETAPA_LEGIVEL[r.allocation_stage] || texto(r.allocation_stage) },
    { header: "ETAPA · SIGEM", key: "sigem_stage", width: 18, value: (r) => ETAPA_LEGIVEL[r.sigem_stage] || texto(r.sigem_stage) },
    { header: "REVISÃO", key: "revision", width: 11, value: (r) => texto(r.revision) },
    { header: "ÚLTIMA GRDT", key: "last_grdt", width: 22, value: (r) => texto(r.last_grdt) },
    { header: "LD CONSIDERADA", key: "ld_name", width: 19, value: (r) => texto(r.ld_name) },
    { header: "VERSÃO DA LD", key: "ld_version_label", width: 16, value: (r) => texto(r.ld_version_label) },
    { header: "LDs EM QUE APARECEU", key: "all_lds", width: 26, value: (r) => texto(r.all_lds) },
    { header: "COMO O FLOW CHEGOU A ISSO", key: "triage_rule", width: 52, value: (r) => texto(r.triage_rule) },
    { header: "RESPONSÁVEL", key: "owner_name", width: 23, value: (r) => texto(r.owner_name) },
    { header: "STATUS DO ITEM", key: "item_status", width: 21, value: (r) => STATUS_LEGIVEL[r.item_status] || texto(r.item_status) },
    { header: "RESPOSTA", key: "answer", width: 45, value: (r) => texto(r.item_answer) || texto(r.request_answer) },
    { header: "PRAZO", key: "due", width: 15, value: (r) => dataBR(r.item_due_at || r.request_due_at) },
    { header: "TRIADA EM", key: "triaged_at", width: 17, value: (r) => dataBR(r.triaged_at) },
  ]);

  function prazoLegivel(dataLimite, fechado) {
    if (!dataLimite) return "—";
    const data = dataBR(dataLimite);
    if (fechado) return data;
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const limite = new Date(`${texto(dataLimite).slice(0, 10)}T00:00:00`);
    if (Number.isNaN(limite.getTime())) return data;
    const dias = Math.round((limite - hoje) / 86400000);
    if (dias < 0) return `${data} · ${Math.abs(dias)}d atrasado`;
    if (dias === 0) return `${data} · hoje`;
    return `${data} · ${dias}d`;
  }

  function consolidarPainel(registros) {
    const porProtocolo = new Map();
    (registros || []).forEach((registro) => {
      const protocolo = texto(registro.protocol);
      if (!protocolo) return;
      let linha = porProtocolo.get(protocolo);
      if (!linha) {
        const fechada = ["concluido", "cancelado"].includes(registro.request_status);
        const prioridadeCodigo = texto(registro.priority) || "normal";
        linha = {
          protocol: protocolo,
          priorityCode: prioridadeCodigo,
          // Normal fica em branco de propósito: uma coluna repetindo "Normal"
          // em 90% das linhas esconde as poucas que importam.
          priority: PRIORIDADE_LEGIVEL[prioridadeCodigo] || "",
          type: texto(registro.type_label),
          // A bifurcação do controle em papel: NOVO ou JÁ PREVISTO. Sai por
          // extenso porque na planilha ninguém pode passar o mouse por cima de
          // um selo para descobrir o que ele quer dizer.
          origin: ORIGEM_LEGIVEL[texto(registro.request_origin)] || "",
          requester: [texto(registro.requester_name), texto(registro.requester_area)].filter(Boolean).join("\n"),
          received: dataBR(registro.received_at),
          owner: texto(registro.owner_name) || "—",
          done: 0,
          total: 0,
          progress: "0/0",
          statusCode: texto(registro.request_status),
          status: STATUS_LEGIVEL[registro.request_status] || texto(registro.request_status),
          dueRaw: registro.request_due_at,
          due: prazoLegivel(registro.request_due_at, fechada),
        };
        porProtocolo.set(protocolo, linha);
      }
      linha.total += 1;
      if (registro.item_status === "concluido") linha.done += 1;
      linha.progress = `${linha.done}/${linha.total}`;
    });
    return [...porProtocolo.values()];
  }

  function linhaDoControle(registro, indice) {
    const semCodigo = !texto(registro.document);
    const observacoes = [
      texto(registro.observations),
      semCodigo && texto(registro.requested_title)
        ? `Sem código informado. Título indicado: ${texto(registro.requested_title)}.`
        : "",
      texto(registro.triage_rule),
      texto(registro.internal_next_action) ? `Próxima ação interna: ${ACAO_LEGIVEL[registro.internal_next_action] || texto(registro.internal_next_action)}.` : "",
      registro.requires_pdf_excel_pair
        ? `LI/MC N-1710: PDF ${registro.pdf_attachment_ready ? "recebido" : "pendente"}; Excel ${registro.excel_attachment_ready ? "recebido" : "pendente"}.`
        : "",
      texto(registro.item_answer) ? `Resposta: ${texto(registro.item_answer)}` : "",
    ].filter(Boolean).join(" ");
    const inclusao = registro.ld_stage === "concluido" ? "não"
      : registro.ld_stage === "nao_aplicavel" ? "não"
      : registro.ld_stage ? "sim"
      : registro.classification === "NAO_LOCALIZADO" ? "sim"
      : ["PRONTO", "ACAO_NECESSARIA", "VALIDAR"].includes(registro.classification) ? "não"
      : "";

    return {
      item: String(indice + 1), owner: texto(registro.owner_name), receivedAt: dataBR(registro.received_at),
      requester: [texto(registro.requester_name), texto(registro.requester_area)].filter(Boolean).join(" / "),
      documentFamily: texto(registro.discipline), requestType: texto(registro.type_label), origin: "GRCON FLOW",
      emailBody: texto(registro.description) || texto(registro.summary), document: texto(registro.document),
      documentPath: "", needsLdInclusion: inclusao, ldVersion: texto(registro.ld_version_label), ldApprovedAt: "",
      allocation: texto(registro.allocation), reference: texto(registro.ld_name), allocSentAt: "",
      fiscal1ReturnedAt: "", fiscal1Answer: "", fiscal2ReturnedAt: "", sigemOwner: "",
      sigemStatus: texto(registro.sigem_status) || (ETAPA_LEGIVEL[registro.sigem_stage] || texto(registro.sigem_stage)), sigemSubmittedAt: "", observations: observacoes,
      pwN1710: "", overallStatus: STATUS_LEGIVEL[registro.request_status] || texto(registro.request_status),
      statusDate: dataBR(registro.item_updated_at),
    };
  }

  function preencherFaixa(aba, linhaInicial, linhaFinal, colunaFinal, cor) {
    for (let linha = linhaInicial; linha <= linhaFinal; linha += 1) {
      for (let coluna = 1; coluna <= colunaFinal; coluna += 1) {
        aba.getCell(linha, coluna).fill = { type: "pattern", pattern: "solid", fgColor: { argb: cor } };
      }
    }
  }

  function cabecalhoDeMarca(aba, totalColunas, titulo, meta) {
    preencherFaixa(aba, 1, 3, totalColunas, AZUL);
    aba.mergeCells(1, 3, 2, totalColunas);
    const celulaTitulo = aba.getCell(1, 3);
    celulaTitulo.value = titulo;
    celulaTitulo.font = { name: "Aptos Display", size: 19, bold: true, color: { argb: "FFFFFFFF" } };
    celulaTitulo.alignment = { vertical: "middle", horizontal: "left" };
    aba.mergeCells(4, 1, 4, totalColunas);
    const celulaMeta = aba.getCell(4, 1);
    celulaMeta.value = meta;
    celulaMeta.font = { name: "Aptos", size: 9, color: { argb: TEXTO_SUAVE } };
    celulaMeta.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF0F4" } };
    celulaMeta.alignment = { vertical: "middle" };
    aba.getRow(1).height = 30;
    aba.getRow(2).height = 30;
    aba.getRow(3).height = 8;
    aba.getRow(4).height = 22;
  }

  function estiloCabecalho(linha, colunas) {
    colunas.forEach((coluna, indice) => {
      const celula = linha.getCell(indice + 1);
      celula.value = coluna.header;
      celula.font = { name: "Aptos", size: 9, bold: true, color: { argb: "FFFFFFFF" } };
      celula.fill = { type: "pattern", pattern: "solid", fgColor: { argb: AZUL_CLARO } };
      celula.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
      celula.border = { bottom: { style: "thin", color: { argb: BORDA } } };
    });
    linha.height = 30;
  }

  function estiloStatus(celula, codigo) {
    const fechado = codigo === "concluido";
    const cancelado = codigo === "cancelado";
    const paleta = fechado ? ["FFE3F5EF", "FF14745F"]
      : cancelado ? ["FFF0F2F4", "FF607381"]
      : ["FFE4F2F8", "FF0A527D"];
    celula.fill = { type: "pattern", pattern: "solid", fgColor: { argb: paleta[0] } };
    celula.font = { name: "Aptos", size: 9, bold: true, color: { argb: paleta[1] } };
  }

  function escreverResumo(aba, registros, descricaoFiltro) {
    const linhas = consolidarPainel(registros);
    aba.columns = COLUNAS_PAINEL.map((coluna) => ({ width: coluna.width }));
    cabecalhoDeMarca(
      aba,
      COLUNAS_PAINEL.length,
      "GRCON FLOW · SOLICITAÇÕES",
      `${linhas.length.toLocaleString("pt-BR")} solicitação(ões) · ${descricaoFiltro} · ${new Date().toLocaleString("pt-BR")}`
    );

    const abertas = linhas.filter((r) => !["concluido", "cancelado"].includes(r.statusCode)).length;
    const concluidas = linhas.filter((r) => r.statusCode === "concluido").length;
    const atrasadas = linhas.filter((r) => r.dueRaw && prazoLegivel(r.dueRaw, false).includes("atrasado")
      && !["concluido", "cancelado"].includes(r.statusCode)).length;
    const cards = [
      ["SOLICITAÇÕES", linhas.length, "FF24689A"],
      ["EM ABERTO", abertas, "FF2E5878"],
      ["CONCLUÍDAS", concluidas, "FF14745F"],
      ["ATRASADAS", atrasadas, "FFA33B36"],
    ];
    cards.forEach(([rotulo, valor, cor], indice) => {
      const inicio = indice * 2 + 1;
      aba.mergeCells(6, inicio, 8, inicio + 1);
      const celula = aba.getCell(6, inicio);
      celula.value = { richText: [
        { font: { name: "Aptos", size: 9, bold: true, color: { argb: TEXTO_SUAVE } }, text: `${rotulo}\n` },
        { font: { name: "Aptos Display", size: 22, bold: true, color: { argb: cor } }, text: Number(valor).toLocaleString("pt-BR") },
      ] };
      celula.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
      celula.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFB" } };
      celula.border = {
        left: { style: "medium", color: { argb: cor } }, top: { style: "thin", color: { argb: BORDA } },
        right: { style: "thin", color: { argb: BORDA } }, bottom: { style: "thin", color: { argb: BORDA } },
      };
    });

    const cabecalho = 10;
    estiloCabecalho(aba.getRow(cabecalho), COLUNAS_PAINEL);
    linhas.forEach((registro, indice) => {
      const linha = aba.getRow(cabecalho + 1 + indice);
      COLUNAS_PAINEL.forEach((coluna, colunaIndice) => {
        const celula = linha.getCell(colunaIndice + 1);
        celula.value = registro[coluna.key] || null;
        celula.font = { name: "Aptos", size: 9, color: { argb: TEXTO } };
        celula.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
        celula.border = { bottom: { style: "hair", color: { argb: BORDA } } };
        if (indice % 2) celula.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
        if (coluna.key === "status") estiloStatus(celula, registro.statusCode);
        if (coluna.key === "priority" && registro.priority) {
          const urgente = registro.priorityCode === "urgente";
          celula.font = { name: "Aptos", size: 9, bold: true, color: { argb: urgente ? "FFA33B36" : "FF8A5C08" } };
          celula.fill = { type: "pattern", pattern: "solid", fgColor: { argb: urgente ? "FFFDE9E7" : "FFFFF3CF" } };
          celula.alignment = { vertical: "middle", horizontal: "center" };
        }
        if (coluna.key === "protocol") celula.font = { name: "Aptos", size: 9, bold: true, color: { argb: AZUL_CLARO } };
        if (coluna.key === "due" && registro.due.includes("atrasado")) {
          celula.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDE9E7" } };
          celula.font = { name: "Aptos", size: 9, bold: true, color: { argb: "FFA33B36" } };
        }
      });
      linha.height = registro.requester.includes("\n") ? 32 : 24;
    });
    const fim = Math.max(cabecalho, cabecalho + linhas.length);
    aba.autoFilter = { from: { row: cabecalho, column: 1 }, to: { row: fim, column: COLUNAS_PAINEL.length } };
    aba.views = [{ state: "frozen", ySplit: cabecalho, activeCell: `A${cabecalho + 1}`, showGridLines: false, zoomScale: 90 }];
    aba.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    aba.headerFooter.oddFooter = "&LGRCON Flow&C&P de &N&R&D";
    return linhas;
  }

  function escreverItens(aba, registros, descricaoFiltro) {
    aba.columns = COLUNAS_ITENS.map((coluna) => ({ width: coluna.width }));
    cabecalhoDeMarca(
      aba,
      COLUNAS_ITENS.length,
      "GRCON FLOW · ITENS E TRIAGEM",
      `${registros.length.toLocaleString("pt-BR")} item(ns) · ${descricaoFiltro}`
    );
    const cabecalho = 6;
    estiloCabecalho(aba.getRow(cabecalho), COLUNAS_ITENS);
    registros.forEach((registro, indice) => {
      const linha = aba.getRow(cabecalho + 1 + indice);
      COLUNAS_ITENS.forEach((coluna, colunaIndice) => {
        const celula = linha.getCell(colunaIndice + 1);
        const valor = coluna.value(registro);
        celula.value = valor === "" ? null : valor;
        celula.font = { name: "Aptos", size: 9, color: { argb: TEXTO } };
        celula.alignment = { vertical: "top", horizontal: "left", wrapText: true };
        celula.border = { bottom: { style: "hair", color: { argb: BORDA } } };
        if (indice % 2) celula.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
        if (coluna.key === "classification") {
          const alerta = ["VALIDAR", "NAO_LOCALIZADO", "ACAO_NECESSARIA", "IDENTIFICACAO_PENDENTE"].includes(registro.classification);
          celula.fill = { type: "pattern", pattern: "solid", fgColor: { argb: alerta ? "FFFFF3CF" : "FFE3F5EF" } };
          celula.font = { name: "Aptos", size: 9, bold: true, color: { argb: alerta ? "FF8A5C08" : "FF14745F" } };
        }
      });
      linha.height = 30;
    });
    const fim = Math.max(cabecalho, cabecalho + registros.length);
    aba.autoFilter = { from: { row: cabecalho, column: 1 }, to: { row: fim, column: COLUNAS_ITENS.length } };
    aba.views = [{ state: "frozen", ySplit: cabecalho, activeCell: `A${cabecalho + 1}`, showGridLines: false, zoomScale: 80 }];
    aba.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    aba.headerFooter.oddFooter = "&LGRCON Flow · Itens&C&P de &N&R&D";
  }

  async function gerar(registros, { nome = "GRCON_FLOW", descricaoFiltro = "registros visíveis no painel" } = {}) {
    const ExcelJS = root.ExcelJS;
    const relatorio = Report();
    if (!ExcelJS || !relatorio) throw new Error("Gerador de planilha indisponível. Recarregue a página.");
    if (!registros.length) throw new Error("Nenhuma linha para exportar com os filtros atuais.");

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "GRCON Flow";
    workbook.company = "CONSAG Engenharia";
    workbook.title = "GRCON Flow — Solicitações";
    workbook.subject = descricaoFiltro;
    workbook.created = new Date();

    const abaPainel = workbook.addWorksheet("Visão do Painel", { views: [{ showGridLines: false }] });
    escreverResumo(abaPainel, registros, descricaoFiltro);

    const abaItens = workbook.addWorksheet("Itens e Triagem", { views: [{ showGridLines: false }] });
    escreverItens(abaItens, registros, descricaoFiltro);

    const linhasControle = registros.map(linhaDoControle);
    const abaControle = workbook.addWorksheet("Controle Oficial", {
      properties: { defaultRowHeight: 18 }, views: [{ showGridLines: false }],
    });
    relatorio.writeControlSheet(abaControle, linhasControle, {
      title: "CONTROLE DE SOLICITAÇÕES",
      metadata: `${linhasControle.length.toLocaleString("pt-BR")} item(ns) · ${descricaoFiltro} · gerado pelo GRCON Flow em ${new Date().toLocaleString("pt-BR")}`,
    });

    // A marca oficial vem do mesmo PNG usado pelo projeto GRCON. Se a imagem
    // não carregar, o arquivo ainda é entregue corretamente.
    await relatorio.attachBrandLogo(workbook, abaPainel, { reportLogoFile: "grcon-logo-report.png" });
    await relatorio.attachBrandLogo(workbook, abaItens, { reportLogoFile: "grcon-logo-report.png" });

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const carimbo = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    link.href = url;
    link.download = `${nome}_${carimbo}.xlsx`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return linhasControle.length;
  }

  function copiar(registros, comCabecalho) {
    const relatorio = Report();
    if (!relatorio) throw new Error("Gerador indisponível.");
    return relatorio.controlClipboardText(registros.map(linhaDoControle), Boolean(comCabecalho));
  }

  root.FlowExport = Object.freeze({
    gerar, copiar, linhaDoControle, consolidarPainel, escreverResumo, escreverItens,
    COLUNAS_PAINEL, COLUNAS_ITENS,
  });
})(window);
