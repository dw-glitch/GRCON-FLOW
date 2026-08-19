/**
 * GRCON — Planilha da consulta de documentos
 *
 * Mesma identidade das planilhas da Triagem de GRDT: faixa azul com o logo,
 * linha de metadados, cabeçalho fixo, filtros, quebra de texto e largura
 * pensada por coluna. O usuário não deveria conseguir dizer, olhando, que a
 * planilha saiu de outro módulo.
 *
 * O construtor fica aqui, e não dentro da tela, pelo mesmo motivo que levou o
 * Resumo do relatório de triagem a ser extraído: assim existe um só desenho,
 * e uma melhoria não chega pela metade.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.GrconRequestsReport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const COLUMNS = Object.freeze([
    { header: "SITUAÇÃO", key: "situation", width: 26 },
    { header: "DOCUMENTO", key: "document", width: 46 },
    { header: "TÍTULO NA LD", key: "title", width: 58 },
    { header: "ALOCADO?", key: "allocated", width: 22 },
    { header: "ALOCAÇÃO", key: "allocation", width: 24 },
    { header: "ÚLTIMA GRDT", key: "lastGrdt", width: 26 },
    // O que a LD diz e o que o próprio GRCON já emitiu são duas perguntas
    // diferentes. Nesta coluna o número da eGRDT vem com a data na linha de
    // baixo, dentro da mesma célula.
    { header: "EMITIDO PELO GRCON (eGRDT e data)", key: "issuedCell", width: 34 },
    { header: "STATUS NO SIGEM", key: "sigemStatus", width: 24 },
    { header: "LD CONSIDERADA", key: "ld", width: 34 },
    { header: "LDs EM QUE FOI LOCALIZADO", key: "allLds", width: 42 },
    { header: "COMO ESTE RESULTADO FOI OBTIDO", key: "rule", width: 62 },
  ]);

  const AZUL = "FF153A5C";
  const AZUL_CLARO = "FF24689A";

  function text(value) {
    return value === null || value === undefined ? "" : String(value).trim();
  }

  function columnLetter(number) {
    let n = Number(number) || 1;
    let result = "";
    while (n > 0) { n -= 1; result = String.fromCharCode(65 + (n % 26)) + result; n = Math.floor(n / 26); }
    return result;
  }

  function situationPalette(value) {
    const normalized = text(value).toUpperCase();
    if (normalized.startsWith("LOCALIZADO")) return ["FFEAF7F1", "FF0C7657"];
    if (normalized.includes("VALIDAÇÃO")) return ["FFFFF5DF", "FFA56812"];
    return ["FFFFF0ED", "FFA64035"];
  }

  function allocationPalette(value) {
    const normalized = text(value).toUpperCase();
    if (normalized.startsWith("SIM")) return ["FFEAF7F1", "FF0C7657"];
    if (normalized.startsWith("NÃO") || normalized.startsWith("NAO")) return ["FFFFF0ED", "FFA64035"];
    if (!normalized) return ["FFF3F5F7", "FF6F7E8C"];
    return ["FFFFF5DF", "FFA56812"];
  }

  /**
   * Monta a aba da consulta numa planilha já criada por quem chama, para o
   * mesmo construtor servir tanto ao arquivo avulso quanto a um pacote maior.
   *
   * As colunas são um parâmetro, e não uma constante lida daqui de dentro,
   * porque os modelos de exportação mudam ordem e nomes. Um segundo construtor
   * só para eles significaria duas planilhas com identidades que divergem na
   * primeira melhoria feita em uma só — foi o que aconteceu com o logo.
   */
  function writeConsultationSheet(worksheet, rows, options) {
    const settings = options || {};
    const lista = rows || [];
    const columns = (settings.columns && settings.columns.length) ? settings.columns : COLUMNS;
    const columnCount = columns.length;
    const lastColumn = columnLetter(columnCount);
    worksheet.columns = columns.map((column) => ({ width: column.width || 24 }));

    for (let row = 1; row <= 3; row += 1) {
      for (let col = 1; col <= columnCount; col += 1) {
        worksheet.getCell(row, col).fill = { type: "pattern", pattern: "solid", fgColor: { argb: AZUL } };
      }
    }
    worksheet.mergeCells(`C1:${lastColumn}2`);
    const titulo = worksheet.getCell("C1");
    titulo.value = text(settings.title) || "GRCON · CONSULTA DE DOCUMENTOS";
    titulo.font = { name: "Aptos Display", size: 19, bold: true, color: { argb: "FFFFFFFF" } };
    titulo.alignment = { vertical: "middle", horizontal: "left" };

    worksheet.mergeCells(`A4:${lastColumn}4`);
    const meta = worksheet.getCell("A4");
    meta.value = text(settings.metadata);
    meta.font = { name: "Aptos", size: 9, color: { argb: "FF52687B" } };
    meta.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF0F4" } };
    meta.alignment = { vertical: "middle" };

    // Os cartões e o aviso leem a coluna SITUAÇÃO. Num modelo que não a inclui
    // — o do Controle de Solicitações, por exemplo — todos os documentos
    // cairiam em "não localizado" e o arquivo abriria com um alarme falso. Sem
    // a coluna, portanto, não há resumo: melhor não dizer do que dizer errado.
    const temSituacao = columns.some((column) => column.key === "situation");
    const localizados = lista.filter((item) => text(item.situation) === "Localizado").length;
    const validar = temSituacao ? lista.filter((item) => text(item.situation) === "Requer validação manual").length : 0;
    const ausentes = temSituacao ? lista.length - localizados - validar : 0;
    if (temSituacao) {
      const cards = [
        ["DOCUMENTOS CONSULTADOS", lista.length, "FF2E5878"],
        ["LOCALIZADOS", localizados, "FF0C7657"],
        ["A VALIDAR", validar, "FFA56812"],
        ["NÃO LOCALIZADOS", ausentes, "FFA64035"],
      ];
      const largura = Math.max(1, Math.floor(columnCount / cards.length));
      cards.forEach(([label, count, cor], index) => {
        const inicio = index * largura + 1;
        const fim = index === cards.length - 1 ? columnCount : inicio + largura - 1;
        worksheet.mergeCells(6, inicio, 8, fim);
        const cell = worksheet.getCell(6, inicio);
        cell.value = { richText: [
          { font: { name: "Aptos", size: 9, bold: true, color: { argb: "FF6F7E8C" } }, text: `${label}\n` },
          { font: { name: "Aptos Display", size: 22, bold: true, color: { argb: cor } }, text: Number(count || 0).toLocaleString("pt-BR") },
        ] };
        cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF7F9FB" } };
        cell.border = {
          left: { style: "medium", color: { argb: cor } },
          top: { style: "thin", color: { argb: "FFDCE4EA" } },
          right: { style: "thin", color: { argb: "FFDCE4EA" } },
          bottom: { style: "thin", color: { argb: "FFDCE4EA" } },
        };
      });
    }

    const origemRow = temSituacao ? 10 : 6;
    worksheet.mergeCells(`A${origemRow}:${lastColumn}${origemRow}`);
    const faixa = worksheet.getCell(`A${origemRow}`);
    faixa.value = "LDs CONSULTADAS";
    faixa.font = { name: "Aptos", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    faixa.fill = { type: "pattern", pattern: "solid", fgColor: { argb: AZUL_CLARO } };
    faixa.alignment = { vertical: "middle" };
    worksheet.getRow(origemRow).height = 22;

    worksheet.mergeCells(`A${origemRow + 1}:${lastColumn}${origemRow + 1}`);
    const lds = worksheet.getCell(`A${origemRow + 1}`);
    lds.value = text(settings.ldNames) || "Nenhuma LD informada";
    lds.font = { name: "Aptos", size: 9, color: { argb: "FF263E52" } };
    lds.alignment = { vertical: "middle", wrapText: true, indent: 1 };
    worksheet.getRow(origemRow + 1).height = 26;

    // Aviso permanente: a planilha não deve ser lida como se tudo estivesse
    // resolvido quando há linhas que dependem de conferência.
    const avisoRow = origemRow + 2;
    if (temSituacao) {
      worksheet.mergeCells(`A${avisoRow}:${lastColumn}${avisoRow}`);
      const aviso = worksheet.getCell(`A${avisoRow}`);
      aviso.value = validar || ausentes
        ? "Atenção: há linhas que o GRCON não conseguiu concluir sozinho. “Requer validação manual” significa que o código foi localizado de outra forma ou que as LDs divergem; “Não localizado” significa que o código não consta em nenhuma LD anexada. Nenhum campo dessas linhas foi preenchido por suposição."
        : "Todos os documentos foram localizados com correspondência exata de código em uma única LD.";
      aviso.font = { name: "Aptos", size: 9, color: { argb: validar || ausentes ? "FF7A5300" : "FF0C7657" } };
      aviso.fill = { type: "pattern", pattern: "solid", fgColor: { argb: validar || ausentes ? "FFFFF3CF" : "FFEAF7F1" } };
      aviso.alignment = { vertical: "middle", wrapText: true, indent: 1 };
      worksheet.getRow(avisoRow).height = 32;
    }

    const headerRow = avisoRow + 2;
    columns.forEach((column, index) => {
      const cell = worksheet.getCell(headerRow, index + 1);
      cell.value = column.header;
      cell.font = { name: "Aptos", size: 9, bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: AZUL } };
      cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
      cell.border = { bottom: { style: "thin", color: { argb: "FFB7C8D6" } } };
    });
    worksheet.getRow(headerRow).height = 32;

    const dataStart = headerRow + 1;
    lista.forEach((item, index) => {
      const row = worksheet.getRow(dataStart + index);
      columns.forEach((column, columnIndex) => {
        const cell = row.getCell(columnIndex + 1);
        // Coluna sem chave é coluna que o modelo reproduz da planilha oficial e
        // o GRCON não tem como preencher. Fica vazia: a estrutura é respeitada
        // sem que apareça um dado que ninguém apurou.
        const value = column.key ? item[column.key] : "";
        cell.value = value === "" || value === null || value === undefined ? null : value;
        cell.font = { name: "Aptos", size: 9, color: { argb: "FF263E52" } };
        cell.alignment = { vertical: "top", horizontal: "left", wrapText: true };
        cell.border = { bottom: { style: "hair", color: { argb: "FFDCE4EA" } } };
        if (index % 2) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
        if (column.key === "situation") {
          const cores = situationPalette(cell.value);
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: cores[0] } };
          cell.font = { name: "Aptos", size: 9, bold: true, color: { argb: cores[1] } };
        }
        if (column.key === "allocated") {
          const coresAloc = allocationPalette(cell.value);
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: coresAloc[0] } };
          cell.font = { name: "Aptos", size: 9, bold: true, color: { argb: coresAloc[1] } };
        }
      });
      const maior = Math.max(...columns.map((column) => text(column.key ? item[column.key] : "").length), 0);
      row.height = Math.min(90, Math.max(32, 20 + Math.ceil(maior / 70) * 14));
    });

    const finalRow = Math.max(headerRow, dataStart + lista.length - 1);
    worksheet.autoFilter = { from: `A${headerRow}`, to: `${lastColumn}${finalRow}` };
    worksheet.views = [{ state: "frozen", ySplit: headerRow, activeCell: `A${dataStart}`, showGridLines: false, zoomScale: 85 }];
    worksheet.pageSetup = {
      orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: .2, right: .2, top: .4, bottom: .4, header: .2, footer: .2 },
      printTitlesRow: `${headerRow}:${headerRow}`,
    };
    worksheet.headerFooter.oddFooter = `&L${text(settings.footer) || "GRCON · Consulta de documentos"}&C&P de &N&R&D`;
    return { headerRow, dataStart, finalRow, lastColumn };
  }

  /**
   * Aplica o logo oficial do GRCON no canto superior da planilha.
   *
   * Vive aqui, e não dentro de cada gerador, porque já existiam duas planilhas
   * com o mesmo logo montado de formas diferentes — e a segunda saiu sem imagem
   * até isto ser unificado. O base64 embutido é o caminho preferido; quando ele
   * está vazio, o PNG é buscado do próprio pacote.
   *
   * Falhar aqui nunca derruba a exportação: o logo é acabamento, e uma planilha
   * correta sem imagem é melhor do que nenhuma planilha.
   */
  async function attachBrandLogo(workbook, worksheet, brandAssets, fetchImpl) {
    try {
      const brand = brandAssets || {};
      let imageConfig = null;
      if (brand.reportLogoBase64) {
        imageConfig = { base64: brand.reportLogoBase64, extension: "png" };
      } else {
        const buscar = fetchImpl || (typeof fetch === "function" ? fetch : null);
        if (!buscar) return false;
        const response = await buscar(brand.reportLogoFile || "grcon-logo-report.png", { cache: "no-store" });
        if (!response || !response.ok) throw new Error("Logo GRCON indisponível");
        imageConfig = { buffer: await response.arrayBuffer(), extension: "png" };
      }
      const image = workbook.addImage(imageConfig);
      worksheet.addImage(image, { tl: { col: .12, row: .28 }, ext: { width: 188, height: 52 } });
      return true;
    } catch (erro) {
      console.debug("[GRCON] logo da planilha indisponível:", erro);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Linhas para o Controle de Solicitações
  //
  // As 26 colunas abaixo são as da planilha oficial da rede, na ordem e com a
  // grafia dela — inclusive os acentos e o hífen curto de "N‑1710". Qualquer
  // diferença aqui obriga a rearrumar as colunas na hora de colar, que é
  // exatamente o retrabalho que esta saída existe para evitar.
  //
  // Na planilha o cabeçalho está na linha 5 e os dados começam na 6; a
  // exportação do GRCON entrega só as linhas de dados, para colar sob o que já
  // existe sem mexer no cabeçalho nem nas validações da planilha.
  // ---------------------------------------------------------------------------
  const CONTROL_COLUMNS = Object.freeze([
    { header: "ITEM", key: "item", width: 8 },
    { header: "Responsavel pela atividade", key: "owner", width: 22 },
    { header: "Data de Recebimento", key: "receivedAt", width: 18 },
    { header: "Solicitante/ Área", key: "requester", width: 24 },
    { header: "Tipo de Documento", key: "documentFamily", width: 16 },
    { header: "Descrição da Solicitação", key: "requestType", width: 30 },
    { header: "Origem da Solicitação", key: "origin", width: 18 },
    { header: "Corpo do e-mail", key: "emailBody", width: 46 },
    { header: "Documento", key: "document", width: 46 },
    { header: "Caminho do Documento", key: "documentPath", width: 40 },
    { header: "Inclusão na LD Necessária?", key: "needsLdInclusion", width: 20 },
    { header: "Versão da LD enviada para Fiscal", key: "ldVersion", width: 22 },
    { header: "Data de Aprovação da LD", key: "ldApprovedAt", width: 20 },
    { header: "Alocação", key: "allocation", width: 24 },
    { header: "Referência", key: "reference", width: 20 },
    { header: "Data de Envio da ALOC para Fiscal 01", key: "allocSentAt", width: 24 },
    { header: "Retorno da Fiscal 01 (Renata)", key: "fiscal1ReturnedAt", width: 22 },
    { header: "Resposta da Fiscal 01 (Renata)", key: "fiscal1Answer", width: 30 },
    { header: "Retorno da Fiscal 02 (Nani)", key: "fiscal2ReturnedAt", width: 22 },
    { header: "Responsável pela Submissão SIGEM", key: "sigemOwner", width: 24 },
    { header: "Status no SIGEM", key: "sigemStatus", width: 22 },
    { header: "Data de Submissão no SIGEM", key: "sigemSubmittedAt", width: 22 },
    { header: "Observações", key: "observations", width: 40 },
    { header: "Disponibilizado no PW – N‑1710", key: "pwN1710", width: 22 },
    { header: "Status Geral da Solicitação", key: "overallStatus", width: 24 },
    { header: "Data de inclusão do status", key: "statusDate", width: 20 },
  ]);

  // "na" é o que a planilha usa para "não se aplica". Repetir essa convenção
  // evita células vazias que depois ninguém sabe se são pendência ou não.
  const NAO_SE_APLICA = "na";

  function controlValue(item, key) {
    const valor = item && item[key];
    if (valor === null || valor === undefined || valor === "") return NAO_SE_APLICA;
    return valor;
  }

  /**
   * Linhas prontas para colar no Controle de Solicitações, uma por item, na
   * ordem exata das colunas da planilha oficial.
   */
  function controlRows(items) {
    return (items || []).map((item) => CONTROL_COLUMNS.map((coluna) => controlValue(item, coluna.key)));
  }

  /** Texto separado por tabulação, para colar direto na planilha. */
  function controlClipboardText(items, includeHeaders) {
    const linhas = controlRows(items).map((linha) => linha.join("\t"));
    if (!includeHeaders) return linhas.join("\n");
    return [CONTROL_COLUMNS.map((coluna) => coluna.header).join("\t"), ...linhas].join("\n");
  }

  /**
   * Planilha no padrão do Controle de Solicitações.
   *
   * Aqui não entra a identidade do GRCON: o arquivo existe para ser colado — ou
   * aberto lado a lado — com o controle oficial da rede, e por isso repete a
   * estrutura dele. Cabeçalho na linha 5, dados a partir da 6, mesma ordem e
   * mesma grafia das 26 colunas. Uma faixa azul e cartões de resumo obrigariam
   * a apagar linhas antes de colar, que é o retrabalho que esta saída evita.
   */
  const CONTROL_HEADER_ROW = 5;

  function writeControlSheet(worksheet, rows, options) {
    const settings = options || {};
    const lista = rows || [];
    const columns = CONTROL_COLUMNS;
    const lastColumn = columnLetter(columns.length);
    worksheet.columns = columns.map((column) => ({ width: column.width || 24 }));

    worksheet.mergeCells(`A1:${lastColumn}1`);
    const titulo = worksheet.getCell("A1");
    titulo.value = text(settings.title) || "CONTROLE DE SOLICITAÇÕES";
    titulo.font = { name: "Aptos Display", size: 14, bold: true, color: { argb: "FF153A5C" } };
    titulo.alignment = { vertical: "middle", horizontal: "left" };

    worksheet.mergeCells(`A2:${lastColumn}2`);
    const meta = worksheet.getCell("A2");
    meta.value = text(settings.metadata);
    meta.font = { name: "Aptos", size: 9, color: { argb: "FF52687B" } };
    meta.alignment = { vertical: "middle", horizontal: "left" };

    const header = worksheet.getRow(CONTROL_HEADER_ROW);
    columns.forEach((column, index) => {
      const cell = header.getCell(index + 1);
      cell.value = column.header;
      cell.font = { name: "Aptos", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: AZUL_CLARO } };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      cell.border = { bottom: { style: "thin", color: { argb: "FFB9C7D2" } } };
    });
    header.height = 34;

    lista.forEach((row, index) => {
      const linha = worksheet.getRow(CONTROL_HEADER_ROW + 1 + index);
      columns.forEach((column, columnIndex) => {
        const cell = linha.getCell(columnIndex + 1);
        // Mesma convenção da planilha: o que não se aplica sai como "na", e não
        // como célula vazia que ninguém sabe se é pendência.
        cell.value = controlValue(row, column.key);
        cell.font = { name: "Aptos", size: 10 };
        cell.alignment = { vertical: "top", wrapText: true };
        if (index % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF6F8FA" } };
      });
    });

    worksheet.autoFilter = {
      from: { row: CONTROL_HEADER_ROW, column: 1 },
      to: { row: CONTROL_HEADER_ROW + lista.length, column: columns.length },
    };
    worksheet.views = [{ state: "frozen", ySplit: CONTROL_HEADER_ROW, showGridLines: false }];
    return { headerRow: CONTROL_HEADER_ROW, firstDataRow: CONTROL_HEADER_ROW + 1, rows: lista.length };
  }

  // ---------------------------------------------------------------------------
  // Modelos de exportação
  //
  // Cada equipe cola o resultado numa planilha diferente, e rearrumar coluna a
  // coluna depois de exportar é o retrabalho que esta aba existe para eliminar.
  // Um modelo guarda a ordem e o nome das colunas; o conteúdo continua vindo do
  // mesmo lugar de sempre.
  //
  // Duas regras que valem para o módulo inteiro valem aqui também:
  //
  // 1. Coluna que o GRCON não sabe preencher fica com a chave vazia e sai em
  //    branco. A estrutura da planilha oficial é reproduzida sem que nenhum
  //    campo seja inventado para tapar buraco.
  // 2. Ao importar um cabeçalho, o casamento é por texto idêntico — só tolera
  //    diferença de caixa, acento, espaço e variação de hífen, que são grafia
  //    do mesmo rótulo. Nada de aproximação: um "Documento" nunca vira
  //    "Caminho do Documento" porque as palavras se parecem.
  // ---------------------------------------------------------------------------
  const TEMPLATE_BASES = Object.freeze({
    consulta: { label: "Consulta de documentos", columns: COLUMNS, title: "GRCON · CONSULTA DE DOCUMENTOS" },
    controle: { label: "Controle de Solicitações", columns: CONTROL_COLUMNS, title: "GRCON · CONTROLE DE SOLICITAÇÕES" },
  });

  function baseOf(name) {
    return TEMPLATE_BASES[text(name)] || TEMPLATE_BASES.consulta;
  }

  /** Campos que um modelo desta base pode usar, com o nome padrão de cada um. */
  function exportFieldCatalog(base) {
    return baseOf(base).columns.map((column) => ({ key: column.key, header: column.header, width: column.width }));
  }

  /** Comparação de rótulos: mesma grafia, escrita de outro jeito. */
  function headerKey(value) {
    return text(value)
      .replace(/[\u2010-\u2015\u2212]/g, "-")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .toUpperCase();
  }

  function slug(value) {
    const base = headerKey(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return base || `modelo-${Date.now()}`;
  }

  function normalizeExportTemplate(input) {
    const raw = input || {};
    const base = TEMPLATE_BASES[text(raw.base)] ? text(raw.base) : "consulta";
    const conhecidas = new Map(exportFieldCatalog(base).map((campo) => [campo.key, campo]));
    const columns = (Array.isArray(raw.columns) ? raw.columns : [])
      .map((column) => {
        const key = conhecidas.has(text(column && column.key)) ? text(column.key) : "";
        const padrao = conhecidas.get(key);
        const header = text(column && column.header) || (padrao ? padrao.header : "");
        const width = Number(column && column.width) || (padrao ? padrao.width : 24);
        return { key, header, width };
      })
      // Sem chave e sem nome não é coluna nenhuma.
      .filter((column) => column.key || column.header);
    const name = text(raw.name) || "Modelo sem nome";
    return {
      id: text(raw.id) || slug(name),
      name,
      base,
      builtIn: Boolean(raw.builtIn),
      scope: text(raw.scope) || "local",
      columns: columns.length ? columns : exportFieldCatalog(base),
    };
  }

  /** Os dois modelos que sempre existem, para a exportação nunca depender de cadastro. */
  const BUILTIN_EXPORT_TEMPLATES = Object.freeze(Object.keys(TEMPLATE_BASES).map((base) => Object.freeze(normalizeExportTemplate({
    id: `padrao-${base}`,
    name: `${baseOf(base).label} (padrão do GRCON)`,
    base,
    builtIn: true,
    scope: "embutido",
    columns: exportFieldCatalog(base),
  }))));

  /**
   * Lê o cabeçalho de uma planilha oficial e devolve um modelo com a estrutura
   * dela: mesma ordem, mesmos nomes. As colunas reconhecidas passam a ser
   * preenchidas pelo GRCON; as demais ficam vazias e são informadas em
   * `unmatched`, para quem importou saber exatamente o que continuará manual.
   */
  function importExportTemplate(name, headers, base) {
    const catalogo = exportFieldCatalog(base);
    const porRotulo = new Map(catalogo.map((campo) => [headerKey(campo.header), campo]));
    const usados = new Set();
    const unmatched = [];
    const columns = (Array.isArray(headers) ? headers : [])
      .map((header) => text(header))
      .filter((header) => header)
      .map((header) => {
        const campo = porRotulo.get(headerKey(header));
        if (!campo || usados.has(campo.key)) {
          unmatched.push(header);
          return { key: "", header, width: 24 };
        }
        usados.add(campo.key);
        return { key: campo.key, header, width: campo.width };
      });
    const modelo = normalizeExportTemplate({ name, base, columns, scope: "local" });
    return { template: modelo, unmatched, matched: usados.size };
  }

  function templateValue(template, row, column) {
    if (!column.key) return "";
    const value = row ? row[column.key] : "";
    return value === null || value === undefined ? "" : value;
  }

  /** Cabeçalho e matriz de valores na ordem do modelo — para prévia e cópia. */
  function applyExportTemplate(template, rows) {
    const modelo = normalizeExportTemplate(template);
    return {
      headers: modelo.columns.map((column) => column.header),
      rows: (rows || []).map((row) => modelo.columns.map((column) => templateValue(modelo, row, column))),
    };
  }

  /** Mesma coisa, cortada — a prévia mostra o que sairia, não uma amostra fictícia. */
  function previewExportTemplate(template, rows, limit) {
    const total = (rows || []).length;
    const corte = Math.max(1, Number(limit) || 5);
    const resultado = applyExportTemplate(template, (rows || []).slice(0, corte));
    return { headers: resultado.headers, rows: resultado.rows, total, hidden: Math.max(0, total - resultado.rows.length) };
  }

  return Object.freeze({
    COLUMNS,
    CONTROL_COLUMNS,
    TEMPLATE_BASES,
    BUILTIN_EXPORT_TEMPLATES,
    exportFieldCatalog,
    normalizeExportTemplate,
    importExportTemplate,
    applyExportTemplate,
    previewExportTemplate,
    controlRows,
    controlClipboardText,
    CONTROL_HEADER_ROW,
    writeControlSheet,
    writeConsultationSheet,
    attachBrandLogo,
  });
});
