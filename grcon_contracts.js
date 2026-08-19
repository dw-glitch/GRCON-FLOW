(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.GrconContracts = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SCHEMA_VERSION = "grcon.document.v1";
  const CODES = Object.freeze({
    READY: "READY_FOR_EGRDT",
    NOT_ALLOCATED: "NOT_ALLOCATED",
    ALLOCATION_CONFLICT: "ALLOCATION_CONFLICT",
    ALLOCATION_UNKNOWN: "ALLOCATION_UNKNOWN",
    DOCUMENT_NOT_FOUND: "DOCUMENT_NOT_FOUND",
    DOCUMENT_AMBIGUOUS: "DOCUMENT_AMBIGUOUS",
    SHEET_MISMATCH: "SHEET_MISMATCH",
    RECORD_CONFLICT: "RECORD_CONFLICT",
    REVISION_MISSING: "REVISION_MISSING",
    REVISION_INVALID: "REVISION_INVALID",
    SIGEM_STATUS_MISSING: "SIGEM_STATUS_MISSING",
    SIGEM_STATUS_CONFLICT: "SIGEM_STATUS_CONFLICT",
    IN_ANALYSIS_RECENT: "IN_ANALYSIS_RECENT",
    POSTED_BY_LD: "POSTED_BY_LD",
    IN_ANALYSIS_REVIEW: "IN_ANALYSIS_INCOMPLETE_OR_OLD",
    PDF_MISSING: "PDF_MISSING",
    PDF_INVALID: "PDF_INVALID",
    PACKAGE_CONFLICT: "PACKAGE_CONFLICT",
    STATUS_REVIEW: "STATUS_REVIEW",
    MANUAL_REVIEW: "MANUAL_REVIEW",
  });

  const _U = (typeof globalThis !== "undefined" ? globalThis : this).GrconUtils || {};
  function text(value) { return _U.text ? _U.text(value) : (value === null || value === undefined ? "" : String(value).trim()); }
  function norm(value) { return _U.norm ? _U.norm(value) : text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[–—]/g, "-").toUpperCase().replace(/\s+/g, " ").trim(); }

  function sourceRef(record) {
    const item = record || {};
    return {
      file: text(item.source),
      sheet: text(item.sheet),
      row: Number(item.row) || 0,
      allocationColumn: text(item.allocationStatusColumn),
      allocationHeader: text(item.allocationStatusHeader),
    };
  }

  function normalizeRecord(record) {
    const item = record || {};
    const allocationState = item.allocationStatusState && item.allocationStatusState.kind
      ? item.allocationStatusState
      : { kind: "empty", raw: text(item.allocationStatus), normalized: norm(item.allocationStatus), label: "Não informado" };
    return {
      ...item,
      schemaVersion: SCHEMA_VERSION,
      document: text(item.document),
      documentKey: text(item.documentKey),
      revision: text(item.revision),
      status: text(item.status),
      sigemStatus: text(item.sigemStatus),
      title: text(item.title),
      databook: text(item.databook),
      allocationStatus: text(item.allocationStatus),
      allocationStatusState: allocationState,
      sourceRef: sourceRef(item),
    };
  }

  function inferReasonCode(row) {
    const item = row || {};
    const status = norm(item.status);
    const reason = norm(item.reason);
    const allocationKind = item.record && item.record.allocationStatusState && item.record.allocationStatusState.kind;

    // O conflito vem antes: a LD com duas respostas para o mesmo documento não é
    // uma não alocação, e dizer que "a LD informa que não está alocado" contradiz
    // a linha da própria LD que diz ALOCADO.
    if (text(item.blockCode) === "not_allocated_conflict") return CODES.ALLOCATION_CONFLICT;
    if (item.hardBlock || allocationKind === "not_allocated" || norm(item.allocationStatus) === "NAO ALOCADO") return CODES.NOT_ALLOCATED;
    if (reason.includes("ALOCACAO CONFLIT") || reason.includes("ALOCADO E NAO ALOCADO")) return CODES.ALLOCATION_CONFLICT;
    if (reason.includes("VALOR") && reason.includes("NAO FOI RECONHECIDO") && reason.includes("ALOC")) return CODES.ALLOCATION_UNKNOWN;
    if (status === "SEM CORRESPONDENCIA NA LD") return CODES.DOCUMENT_NOT_FOUND;
    if (status === "CODIGO AMBIGUO NO NOME") return CODES.DOCUMENT_AMBIGUOUS;
    if (status === "ABA INCOMPATIVEL") return CODES.SHEET_MISMATCH;
    if (status === "CONFLITO NA LD" || status === "REGISTROS CONFLITANTES" || status === "PACOTE INCONSISTENTE" || status === "REVISOES DIVERGENTES NO PACOTE") return CODES.RECORD_CONFLICT;
    if (status === "REVISAO VAZIA NA LD") return CODES.REVISION_MISSING;
    if (status === "REVISAO INVALIDA" || status === "REVISAO INVALIDA NO NOME") return CODES.REVISION_INVALID;
    if (status === "STATUS VAZIO NA COLAR SIGEM") return CODES.SIGEM_STATUS_MISSING;
    if (status === "CONFLITO NA COLAR SIGEM") return CODES.SIGEM_STATUS_CONFLICT;
    if (status === "PDF NAO LOCALIZADO") return CODES.PDF_MISSING;
    if (status === "PDF INVALIDO" || status === "PDF NAO VALIDADO" || status === "ARQUIVO VAZIO") return CODES.PDF_INVALID;
    // A decisão final de inclusão prevalece sobre evidências auxiliares da LD.
    // Assim, “Em Análise” e ausência na Colar SIGEM podem gerar eGRDT quando
    // todas as validações obrigatórias estiverem corretas.
    if (item.decision === "pronto") return CODES.READY;
    if (item.postingEvidence && item.postingEvidence.complete) return CODES.POSTED_BY_LD;
    if (item.decision === "descartar" && status === "EM ANALISE") return CODES.IN_ANALYSIS_RECENT;
    if (status === "EM ANALISE") return CODES.IN_ANALYSIS_REVIEW;
    if (reason.includes("STATUS OFICIAL") || reason.includes("NAO AUTORIZA AVANCO")) return CODES.STATUS_REVIEW;
    return CODES.MANUAL_REVIEW;
  }

  function messageFor(code, row) {
    const item = row || {};
    const revision = text(item.revision) || "informada";
    const status = text(item.status) || "não informado";
    const fiscal = text(item.fiscalComment);
    const suffix = fiscal ? ` Comentário da Fiscal: ${fiscal}` : "";
    const messages = {
      [CODES.READY]: {
        severity: "success",
        title: "Será incluído na eGRDT.",
        explanation: `A revisão ${revision} está liberada para postagem.`,
        nextAction: "Confira os dados finais e gere a eGRDT.",
      },
      [CODES.NOT_ALLOCATED]: {
        severity: "error",
        title: "Não será incluído na eGRDT.",
        explanation: `A LD informa que o documento não está alocado.${suffix}`,
        nextAction: "Regularize a alocação na LD antes de tentar novamente.",
      },
      [CODES.ALLOCATION_CONFLICT]: {
        severity: "warning",
        title: "A LD dá duas respostas para este documento.",
        explanation: "Uma linha registra ALOCADO e outra registra NÃO ALOCADO. O GRCON não escolhe entre elas e não afirma nenhuma das duas.",
        nextAction: "Confirme na LD qual linha vale. O documento fica fora da eGRDT automática até lá; a inclusão manual continua disponível.",
      },
      [CODES.ALLOCATION_UNKNOWN]: {
        severity: "warning",
        title: "Precisa de conferência antes de continuar.",
        explanation: `O valor de alocação “${text(item.allocationStatus) || "vazio"}” não foi reconhecido.`,
        nextAction: "Confira se a coluna de alocação foi associada corretamente.",
      },
      [CODES.DOCUMENT_NOT_FOUND]: {
        severity: "warning",
        title: "Não foi possível analisar este documento.",
        explanation: "O código do documento não foi encontrado na LD.",
        nextAction: "Confira o nome do arquivo e use a LD mais recente.",
      },
      [CODES.DOCUMENT_AMBIGUOUS]: {
        severity: "warning",
        title: "Não foi possível escolher o documento correto.",
        explanation: "O nome informado contém mais de um código encontrado na LD.",
        nextAction: "Confirme qual código deve ser usado.",
      },
      [CODES.SHEET_MISMATCH]: {
        severity: "warning",
        title: "Precisa de conferência antes de continuar.",
        explanation: "O documento foi encontrado em uma aba diferente da indicada pelo arquivo.",
        nextAction: "Confirme a aba correta na LD.",
      },
      [CODES.RECORD_CONFLICT]: {
        severity: "warning",
        title: "Precisa de conferência antes de continuar.",
        explanation: "A LD possui mais de um registro diferente para este documento.",
        nextAction: "Escolha a linha correta antes de gerar a eGRDT.",
      },
      [CODES.REVISION_MISSING]: {
        severity: "warning",
        title: "Não será incluído enquanto a revisão estiver vazia.",
        explanation: "A LD não informa a revisão controlada do documento.",
        nextAction: "Preencha ou confirme a revisão na LD.",
      },
      [CODES.REVISION_INVALID]: {
        severity: "warning",
        title: "Não será incluído enquanto a revisão estiver inválida.",
        explanation: "A revisão não segue a sequência aceita pelo processo.",
        nextAction: "Corrija ou confirme a revisão antes de continuar.",
      },
      [CODES.SIGEM_STATUS_MISSING]: {
        severity: "warning",
        title: "Precisa de conferência antes de continuar.",
        explanation: `A revisão ${revision} aparece no SIGEM, mas o status está vazio.`,
        nextAction: "Preencha ou confirme o status na base SIGEM.",
      },
      [CODES.SIGEM_STATUS_CONFLICT]: {
        severity: "warning",
        title: "Precisa de conferência antes de continuar.",
        explanation: `A revisão ${revision} aparece com status diferentes na base SIGEM.`,
        nextAction: "Corrija o conflito antes de gerar a eGRDT.",
      },
      [CODES.POSTED_BY_LD]: {
        severity: "info",
        title: "Não será enviado novamente.",
        explanation: text(item.reason) || "A própria LD contém número da GRDT e Data Efetiva de Emissão para esta revisão.",
        nextAction: "Atualize a Colar SIGEM quando possível e não repita a postagem.",
      },
      [CODES.IN_ANALYSIS_RECENT]: {
        severity: "info",
        title: "Não será enviado novamente agora.",
        explanation: `A revisão ${revision} está em análise, com GRDT e emissão recente confirmadas.`,
        nextAction: "Aguarde o retorno antes de preparar uma nova revisão.",
      },
      [CODES.IN_ANALYSIS_REVIEW]: {
        severity: "warning",
        title: "Confira antes de decidir.",
        explanation: text(item.reason) || `A revisão ${revision} está em análise, mas a GRDT ou a data de emissão não comprovam um envio recente.`,
        nextAction: "Confira a GRDT, a data efetiva e a linha indicada no relatório.",
      },
      [CODES.PDF_MISSING]: {
        severity: "warning",
        title: "O pacote físico ainda não pode ser gerado.",
        explanation: "O PDF deste documento não foi localizado.",
        nextAction: "Adicione o PDF correto e analise novamente.",
      },
      [CODES.PDF_INVALID]: {
        severity: "error",
        title: "O arquivo não pode ser usado.",
        explanation: "O PDF está vazio, inválido ou não pôde ser aberto.",
        nextAction: "Substitua o arquivo pelo PDF correto.",
      },
      [CODES.STATUS_REVIEW]: {
        severity: "warning",
        title: "Precisa de conferência antes de continuar.",
        explanation: `O status “${status}” não possui uma ação automática segura.`,
        nextAction: "Confira o documento no SIGEM e defina a próxima ação.",
      },
      [CODES.MANUAL_REVIEW]: {
        severity: "warning",
        title: "Precisa de conferência antes de continuar.",
        explanation: text(item.reason) || "O GRCON não encontrou informação suficiente para decidir com segurança.",
        nextAction: "Confira os dados na LD e no SIGEM.",
      },
    };
    return { code, ...(messages[code] || messages[CODES.MANUAL_REVIEW]) };
  }

  function enrichDecision(row, explicitCode) {
    const item = { ...(row || {}) };
    const reasonCode = explicitCode || inferReasonCode(item);
    const message = messageFor(reasonCode, item);
    // O aviso de "nt-" precisa aparecer no texto que a relação mostra, e não só
    // no motivo interno: é ele que explica por que o nome do arquivo mudou.
    const nota = item.ntRename && item.ntRename.nota ? String(item.ntRename.nota) : "";
    const userMessage = nota
      ? { ...message, explanation: `${message.explanation} ${nota}`.trim() }
      : message;
    return { ...item, reasonCode, userMessage };
  }

  function validateRecord(record) {
    const item = normalizeRecord(record);
    const errors = [];
    if (!item.document) errors.push("Documento não informado");
    if (!item.documentKey) errors.push("Chave do documento não informada");
    if (!item.sourceRef.sheet) errors.push("Aba de origem não informada");
    if (!item.sourceRef.row) errors.push("Linha de origem não informada");
    return { valid: errors.length === 0, errors, record: item };
  }

  return {
    SCHEMA_VERSION,
    CODES,
    text,
    norm,
    sourceRef,
    normalizeRecord,
    inferReasonCode,
    messageFor,
    enrichDecision,
    validateRecord,
  };
});
