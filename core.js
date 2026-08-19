(function (root, factory) {
  const contracts = root.GrconContracts || (typeof module === "object" && module.exports ? require("./grcon_contracts.js") : null);
  const api = factory(contracts);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.TriagemCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Contracts) {
  "use strict";

  const READY = "pronto";
  const DISCARD = "descartar";
  const REVIEW = "revisar";

  const REVISION_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const N1710_CATEGORIES = new Set([
    "CE", "CR", "DB", "DE", "EC", "ET", "FD", "IM", "IS", "LA",
    "LD", "LI", "LO", "MA", "MC", "MD", "MO", "PR", "PT", "RL",
    "RM", "CT", "SIT",
  ]);
  const REPORT_DISCIPLINES = new Set([
    "ADC", "ARR", "DBU", "CVL", "CTO", "CRS", "CDR", "DOC", "ELE",
    "REQ", "ETF", "FSC", "FOR", "GER", "HVAC", "INSP", "INS", "PDMS",
    "MEC", "DIN", "EST", "PLA", "PRS", "PRJ", "QUA", "SMS", "SEG",
    "SIS", "SUP", "TEL", "TUB",
  ]);
  const EGRDT_OPTIONS = Object.freeze({
    formats: ["A0", "A1", "A2", "A3", "A4"],
    disciplines: [
      "DINÂMICOS", "ESTÁTICOS", "MONTAGEM", "COMISSIONAMENTO", "SUPRIMENTOS",
      "ELÉTRICA", "ENGENHARIA DE PROJETO", "ESTRUTURA METÁLICA",
      "FERRAMENTAS COMPUTACIONAIS", "INSTRUMENTAÇÃO", "MECÂNICA", "MEIO AMBIENTE",
      "SEGURANÇA", "PLANEJAMENTO", "COMUNICAÇÃO E RS", "ADM CONTRATUAL", "GERAL",
      "QUALIDADE", "CIVIL", "SAÚDE", "TUBULAÇÃO", "COORDENAÇÃO",
    ],
    documentTypes: [
      "AD", "AF", "AL", "ART", "AS", "AT", "CE", "CO", "CR", "CT", "CV",
      "DB", "DTRI", "DE", "DTRA", "ET", "FD", "GES", "HIS", "IM", "IS",
      "LA", "LD", "LI", "LO", "MA", "MC", "MD", "MO", "ORG", "PR", "PT",
      "RL", "RM", "SG", "SUB",
    ],
    purposes: [
      "Para Compra", "Para Construção", "Conforme Construído", "Certificado",
      "Pendente Certificação", "Cancelado", "Emitido para Comentários",
      "Para Cancelamento", "Para Informação", "Para Liberação",
    ],
  });
  function text(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim();
  }

  function norm(value) {
    return text(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[–—]/g, "-")
      .toUpperCase()
      .replace(/\s+/g, " ")
      .trim();
  }


  function allocationState(value) {
    const raw = text(value);
    const s = norm(raw).replace(/[.!;:]+$/g, "").trim();
    if (!s) return { kind: "empty", raw, normalized: s, label: "Não informado" };
    const positive = new Set([
      "ALOCADO", "SIM", "ACEITO", "APROVADO", "CONFIRMADO", "CONCLUIDO",
      "OK", "DOCUMENTO ALOCADO", "ALOCACAO ACEITA", "ACEITE", "ALOCACAO CONFIRMADA"
    ]);
    const negative = new Set([
      "NAO ALOCADO", "NAO", "RECUSADO", "REJEITADO", "ALOCACAO RECUSADA",
      "DOCUMENTO NAO ALOCADO"
    ]);
    if (positive.has(s)) return { kind: "allocated", raw, normalized: s, label: "Alocado" };
    if (negative.has(s)) return { kind: "not_allocated", raw, normalized: s, label: "Não alocado" };
    return { kind: "unknown", raw, normalized: s, label: "Valor não reconhecido" };
  }

  // Um número de alocação só vale como evidência quando é o identificador de uma
  // ALOC: precisa trazer o token ALOC isolado e uma sequência numérica. Texto
  // livre na mesma coluna ("Já alocado / Sem rastreio de alocação") não prova
  // alocação nenhuma e continua fora.
  function allocationNumberInfo(value) {
    const raw = text(value);
    const normalized = norm(raw);
    if (!normalized) return { valid: false, raw, normalized, reason: "vazio" };
    if (/^(?:0|-|X|N\/A|NA|NAO APLICAVEL|NAO SE APLICA|A DEFINIR|A ALOCAR|PENDENTE|SEM ALOCACAO)$/.test(normalized)) {
      return { valid: false, raw, normalized, reason: "sem valor operacional" };
    }
    const hasToken = /(?:^|[^A-Z])ALOC(?:[^A-Z]|$)/.test(normalized);
    const hasSequence = /\d{3,}/.test(normalized);
    if (hasToken && hasSequence) return { valid: true, raw, normalized, reason: "identificador de ALOC" };
    return { valid: false, raw, normalized, reason: "texto livre" };
  }

  /**
   * Situação de alocação lida da linha inteira, e não só da célula de status.
   *
   * Separa três fatos que a leitura antiga confundia num único "vazio":
   * coluna inexistente na aba (a LD não rastreia o dado), célula vazia com a
   * coluna presente (a LD rastreia e não informou) e número de ALOC registrado
   * sem status (a alocação está evidenciada pelo próprio número).
   */
  function allocationEvidenceState(record) {
    const item = record || {};
    const status = allocationState(item.allocationStatus);
    const number = allocationNumberInfo(item.allocation);
    const tracked = Boolean(text(item.allocationStatusColumn));
    if (status.kind !== "empty") {
      return {
        ...status,
        tracked,
        evidence: "status",
        allocationNumber: number.valid ? number.raw : "",
        source: `campo “${text(item.allocationStatusHeader) || "confirmação de alocação"}”`,
      };
    }
    if (number.valid) {
      return {
        kind: "allocated",
        raw: number.raw,
        normalized: number.normalized,
        label: "Alocado pelo número de ALOC",
        tracked,
        evidence: "number",
        allocationNumber: number.raw,
        source: `número de alocação ${number.raw}`,
      };
    }
    if (!tracked) {
      return {
        kind: "not_tracked",
        raw: "",
        normalized: "",
        label: "A LD não rastreia alocação nesta aba",
        tracked: false,
        evidence: "none",
        allocationNumber: "",
        source: `aba ${text(item.sheet) || "técnica"} sem coluna de confirmação de alocação`,
      };
    }
    return {
      kind: "blank",
      raw: "",
      normalized: "",
      label: "Alocação não informada na LD",
      tracked: true,
      evidence: "none",
      allocationNumber: "",
      source: `campo “${text(item.allocationStatusHeader) || "confirmação de alocação"}” vazio`,
    };
  }

  /**
   * A linha mais recente de um conjunto. A LD cresce para baixo e é reenviada
   * de tempos em tempos, então a ordem é: arquivo mais novo, aba mais nova e,
   * dentro da mesma aba, a linha de baixo.
   */
  function mostRecentRecord(records) {
    return (records || []).filter(Boolean).slice().sort((a, b) => (
      (Number(b.sourceTimestamp) || 0) - (Number(a.sourceTimestamp) || 0)
      || (Number(b.sourceOrder) || 0) - (Number(a.sourceOrder) || 0)
      || (Number(b.row) || 0) - (Number(a.row) || 0)
    ))[0] || null;
  }

  /** Onde a linha está, para a evidência citar arquivo, aba e linha. */
  function recordLocation(record) {
    const item = record || {};
    return [text(item.source), item.sheet ? `aba ${text(item.sheet)}` : "", item.row ? `linha ${item.row}` : ""]
      .filter(Boolean).join(" · ");
  }

  function allocationConflictSummary(records) {
    const states = (records || []).map((item) => ({ item, state: allocationState(item && item.allocationStatus) }));
    const kinds = new Set(states.map((entry) => entry.state.kind).filter((kind) => kind !== "empty"));
    return {
      states,
      kinds,
      mixed: kinds.has("allocated") && kinds.has("not_allocated"),
      allNegative: kinds.size === 1 && kinds.has("not_allocated"),
      anyNegative: kinds.has("not_allocated"),
      anyUnknown: kinds.has("unknown"),
    };
  }

  function canonicalId(value) {
    return norm(value)
      .replace(/\s*([_.-])\s*/g, "$1")
      .replace(/\s+/g, " ");
  }

  function key(value) {
    return canonicalId(value);
  }

  function sheetFamily(value) {
    const normalized = norm(value);
    if (/^N-1710(?:\s|$)/.test(normalized)) return "N-1710";
    return normalized;
  }

  function sheetMatchesHint(sheetName, hintedSheet) {
    const hint = sheetFamily(hintedSheet);
    return !hint || sheetFamily(sheetName) === hint;
  }

  function isEtDocument(value, sheetName) {
    if (norm(sheetName) === "ET") return true;
    const documentKey = key(value);
    return /(?:^|[^A-Z0-9])[A-Z0-9]{3}_RNEST_[A-Z0-9]+_\d+(?:\.\d+){3}_[A-Z0-9]+_[A-Z0-9][A-Z0-9.-]*_/.test(documentKey);
  }

  function etCodeParts(value) {
    const documentKey = key(value);
    const match = documentKey.match(/^([A-Z0-9]{3}_RNEST_[A-Z0-9]+_\d+(?:\.\d+){3}_[A-Z0-9]+_[A-Z0-9][A-Z0-9.-]*_)(.+)$/);
    return match ? { documentKey, prefix: match[1], identifier: match[2] } : null;
  }

  function etTagComparable(value) {
    const parts = etCodeParts(value);
    if (!parts) return null;
    const groups = parts.prefix.slice(0, -1).split("_");
    const reportCode = groups.length === 6 ? groups[5] : "";
    if (!reportCode) return null;
    const identifier = parts.identifier.replace(/^NT(?=[-._/\\\s])[-._/\\\s]*/, "");
    const compact = identifier.replace(/[^A-Z0-9]/g, "");
    if (!compact) return null;
    const confusableCompact = compact.replace(/[OILSZB]/g, (character) => ({ O: "0", I: "1", L: "1", S: "5", Z: "2", B: "8" })[character]);
    return {
      prefix: parts.prefix,
      reportCode,
      identifier,
      compact,
      formatKey: `${parts.prefix}${compact}`,
      confusableKey: `${parts.prefix}${confusableCompact}`,
      reportTagKey: `${reportCode}::${compact}`,
      reportTagConfusableKey: `${reportCode}::${confusableCompact}`,
    };
  }

  function singleConfusableDifference(left, right) {
    if (!left || !right || left.length !== right.length) return false;
    const pairs = new Set(["0O", "O0", "1I", "I1", "1L", "L1", "5S", "S5", "2Z", "Z2", "8B", "B8"]);
    let differences = 0;
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] === right[index]) continue;
      differences += 1;
      if (differences > 1 || !pairs.has(`${left[index]}${right[index]}`)) return false;
    }
    return differences === 1;
  }

  function etTagVariantKind(inputValue, ldValue) {
    const input = etTagComparable(inputValue);
    const ld = etTagComparable(ldValue);
    if (!input || !ld || input.prefix !== ld.prefix) return "";
    if (input.compact === ld.compact) return key(inputValue) === key(ldValue) ? "" : "tag-format-variant";
    if (input.confusableKey === ld.confusableKey && singleConfusableDifference(input.compact, ld.compact)) {
      return "tag-transcription-variant";
    }
    return "";
  }

  /**
   * O "nt-" pertence exclusivamente ao início do 7º grupo do código ET, como
   * em C1O_RNEST_U32_3.1.1.1_INS_RIR_nt-SPE-AST-320019. A neutralização não é
   * aplicada à N-1710 nem a outras famílias documentais.
   */
  function ntNeutralKey(value) {
    const parts = etCodeParts(value);
    if (!parts) return key(value);
    return `${parts.prefix}${parts.identifier.replace(/^NT-/, "")}`;
  }

  /**
   * Forma de apresentação do código ET. A comparação continua normalizada pela
   * função key(), mas o prefixo documental é sempre mostrado como "nt-".
   */
  function displayDocumentCode(value) {
    const parts = etCodeParts(value);
    if (!parts) return canonicalId(value);
    return `${parts.prefix}${parts.identifier.replace(/^NT-/, "nt-")}`;
  }

  /** A outra forma do mesmo código ET: sem o "nt-" se existe, com ele se não. */
  function ntPrefixVariant(value) {
    const parts = etCodeParts(value);
    if (!parts) return "";
    return parts.identifier.startsWith("NT-")
      ? `${parts.prefix}${parts.identifier.slice(3)}`
      : `${parts.prefix}nt-${parts.identifier}`;
  }

  function documentSearchKeys(value) {
    const documentKey = key(value);
    if (!isEtDocument(documentKey)) return documentKey ? [documentKey] : [];
    const withoutNt = ntNeutralKey(documentKey);
    const withNt = ntNeutralKey(documentKey) === documentKey
      ? ntPrefixVariant(documentKey)
      : displayDocumentCode(documentKey);
    return [...new Set([withoutNt, withNt].filter(Boolean))];
  }

  function ntPrefixForm(value) {
    const documentKey = key(value);
    if (!documentKey) return "Não localizado";
    if (!isEtDocument(documentKey)) return isN1710Context("", documentKey) ? "Não se aplica — N-1710" : "Não se aplica";
    return ntNeutralKey(documentKey) !== documentKey ? "Com nt-" : "Sem nt-";
  }

  function documentLookup(identityValue, match, candidates) {
    const rawIdentity = text(identityValue).split(/[\\/]/).pop().replace(/\.[A-Z0-9]{1,8}$/i, "");
    const inputDocument = displayDocumentCode(text(match && match.matchedSearchKey) || rawIdentity);
    const ldDocument = text(match && match.document);
    const matched = Boolean(match && ldDocument);
    const appliesToNtRule = isEtDocument(inputDocument) || isEtDocument(ldDocument, match && match.group && match.group.records && match.group.records[0] && match.group.records[0].sheet);
    const searchedKeys = appliesToNtRule ? documentSearchKeys(inputDocument) : [key(inputDocument)].filter(Boolean);
    const searchedWithoutNt = appliesToNtRule ? ntNeutralKey(inputDocument) : "";
    const searchedWithNt = appliesToNtRule ? searchedKeys[1] || "" : "";
    const matchedByNtVariant = Boolean(
      matched
      && appliesToNtRule
      && key(inputDocument) !== key(ldDocument)
      && ntNeutralKey(inputDocument) === ntNeutralKey(ldDocument)
    );
    const matchedByReportTag = Boolean(matched && appliesToNtRule && match && /^report-tag(?:-transcription)?$/.test(match.matchKind || ""));
    const matchedByTagVariant = Boolean(matched && appliesToNtRule && match && /^tag-(?:format|transcription)-variant$/.test(match.matchKind || ""));
    const searchedTagInfo = appliesToNtRule ? etTagComparable(inputDocument) : null;
    const searchedTag = searchedTagInfo && searchedTagInfo.identifier || "";
    const searchedReportCode = searchedTagInfo && searchedTagInfo.reportCode || "";
    const ldFormInSentence = ntPrefixForm(ldDocument).replace(/^./, (character) => character.toLowerCase());
    const ambiguous = !matched && Array.isArray(candidates) && candidates.length > 1;
    const searchResult = !appliesToNtRule
      ? matched ? "not-applicable-found" : "not-applicable-not-found"
      : ambiguous ? "ambiguous"
        : !matched ? "not-found-both"
          : matchedByNtVariant ? "found-alternate-renamed"
            : matchedByReportTag ? "found-by-report-tag"
            : matchedByTagVariant ? "found-in-ld" : "found-exact";
    const resultLabel = {
      "not-applicable-found": "NÃO SE APLICA — localizado pela regra normal",
      "not-applicable-not-found": "NÃO SE APLICA — não localizado",
      ambiguous: "MAIS DE UMA CORRESPONDÊNCIA — CONFERIR",
      "not-found-both": "NÃO LOCALIZADO COM/SEM nt- NEM PELO TIPO + TAG",
      "found-alternate-renamed": "LOCALIZADO NA OUTRA FORMA — USAR O CÓDIGO DA LD",
      "found-by-report-tag": "LOCALIZADO PELO TIPO + TAG — USAR O CÓDIGO DA LD",
      "found-in-ld": "LOCALIZADO NA LD",
      "found-exact": "LOCALIZADO NA MESMA FORMA",
    }[searchResult];
    let message;
    if (!appliesToNtRule) {
      const n1710 = isN1710Context("", inputDocument || ldDocument);
      message = matched
        ? `${n1710 ? "Documento N-1710: a regra com/sem nt- não se aplica." : "A regra com/sem nt- não se aplica a esta família documental."} O código foi pesquisado somente na forma informada e localizado na LD como “${ldDocument}”.`
        : `${n1710 ? "Documento N-1710: a regra com/sem nt- não se aplica." : "A regra com/sem nt- não se aplica a esta família documental."} O código foi pesquisado somente na forma informada (${searchedKeys.join(" | ") || "código vazio"}) e não foi localizado na LD.`;
    } else if (!matched) {
      message = ambiguous
        ? `Pesquisa pelo código completo com e sem nt- e pela combinação tipo “${searchedReportCode || "não identificado"}” + TAG${searchedTag ? ` “${searchedTag}”` : ""} realizada. Mais de uma correspondência do mesmo tipo foi localizada na LD; confira o código correto.`
        : `Pesquisa pelo código completo com e sem nt- realizada (${searchedKeys.join(" | ")}) e busca pela combinação tipo “${searchedReportCode || "não identificado"}” + TAG${searchedTag ? ` “${searchedTag}”` : ""} concluída. Nenhum documento desse mesmo tipo foi localizado na LD. Um TAG igual pertencente a outro tipo documental não é aceito.`;
    } else if (matchedByNtVariant) {
      message = `Pesquisa com e sem nt- realizada (${searchedKeys.join(" | ")}). O código informado “${inputDocument}” foi localizado na LD ${ldFormInSentence} como “${ldDocument}”. O arquivo final e a eGRDT usarão o código exatamente como está na LD.`;
    } else if (matchedByReportTag) {
      message = `Pesquisa pelo código completo com e sem nt- realizada (${searchedKeys.join(" | ")}). Como essas formas não foram localizadas, o GRCON pesquisou a combinação tipo “${searchedReportCode}” + TAG “${searchedTag}” e encontrou uma única correspondência: “${ldDocument}”. Os demais grupos foram corrigidos pela codificação oficial da LD; o arquivo final e a eGRDT usarão esse código exatamente como está na LD.`;
    } else if (matchedByTagVariant) {
      message = `Pesquisa com e sem nt- realizada (${searchedKeys.join(" | ")}). Código localizado na LD como “${ldDocument}”. O arquivo final e a eGRDT usarão o código exatamente como está na LD.`;
    } else {
      message = `Pesquisa com e sem nt- realizada (${searchedKeys.join(" | ")}). Localizado na LD exatamente como “${ldDocument}” (${ldFormInSentence}).`;
    }
    return {
      inputDocument,
      searchedKeys,
      searchedWithoutNt,
      searchedWithNt,
      appliesToNtRule,
      matched,
      matchedByNtVariant,
      matchedByTagVariant,
      matchedByReportTag,
      searchedTag,
      searchedReportCode,
      ldDocument,
      ldForm: matched ? ntPrefixForm(ldDocument) : "Não localizado",
      searchResult,
      resultLabel,
      message,
    };
  }

  function statusKind(value) {
    const s = norm(value);
    const exact = {
      "NAO POSTADO": "not_posted",
      "EM ANALISE": "analysis",
      "COM COMENTARIOS": "advance",
      "SEM COMENTARIOS": "advance",
      "ACEITO SEM COMENTARIOS": "advance",
      "RECUSADO": "advance",
      "PARA CONSTRUCAO": "issued",
      "CONFORME CONSTRUIDO": "issued",
      "PARA COMPRA": "issued",
      "EM WORKFLOW": "pending",
      "PENDENTE CERTIFICACAO": "pending",
      "CANCELADO": "closed",
    };
    return exact[s] || "unknown";
  }

  function normalizeRevision(value) {
    return norm(value).replace(/^REV(?:ISAO)?\.?\s*/, "").replace(/\s+/g, "");
  }

  function revisionInfo(value) {
    const revision = normalizeRevision(value);
    if (revision === "0") return { revision, valid: true, kind: "standard", rank: 0 };
    if (/^[A-Z]+$/.test(revision)) {
      if ([...revision].some((letter) => !REVISION_ALPHABET.includes(letter))) {
        return { revision, valid: false, kind: "invalid", rank: -1 };
      }
      let rank = 0;
      for (const letter of revision) rank = rank * REVISION_ALPHABET.length + REVISION_ALPHABET.indexOf(letter) + 1;
      return { revision, valid: true, kind: "standard", rank: rank * 1000 };
    }
    const field = revision.match(/^([A-Z]+)([1-9]\d*)$/);
    if (field && [...field[1]].every((letter) => REVISION_ALPHABET.includes(letter))) {
      const base = revisionInfo(field[1]);
      return { revision, valid: true, kind: "field", rank: base.rank + Number(field[2]) };
    }
    return { revision, valid: false, kind: "invalid", rank: -1 };
  }

  function revisionRank(value) {
    return revisionInfo(value).rank;
  }

  function nextRevision(value) {
    const info = revisionInfo(value);
    if (!info.valid || info.kind !== "standard") return "";
    if (info.revision === "0") return "A";
    const digits = [...info.revision].map((letter) => REVISION_ALPHABET.indexOf(letter));
    let position = digits.length - 1;
    while (position >= 0 && digits[position] === REVISION_ALPHABET.length - 1) {
      digits[position] = 0;
      position -= 1;
    }
    if (position < 0) digits.unshift(0);
    else digits[position] += 1;
    return digits.map((digit) => REVISION_ALPHABET[digit]).join("");
  }

  function parseDate(value) {
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    if (typeof value === "number" && value > 20000) {
      const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    const raw = text(value);
    const br = raw.match(/^(\d{1,2})[\/]([01]?\d)[\/](\d{4}|\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (br) {
      let year = Number(br[3]);
      if (year < 100) year += 2000;
      const month = Number(br[2]);
      const day = Number(br[1]);
      const hour = Number(br[4] || 0);
      const minute = Number(br[5] || 0);
      const second = Number(br[6] || 0);
      const date = new Date(year, month - 1, day, hour, minute, second);
      if (Number.isNaN(date.getTime()) || date.getFullYear() !== year || date.getMonth() !== month - 1
        || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) return null;
      return date;
    }
    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (iso) {
      const year = Number(iso[1]);
      const month = Number(iso[2]);
      const day = Number(iso[3]);
      const hour = Number(iso[4] || 0);
      const minute = Number(iso[5] || 0);
      const second = Number(iso[6] || 0);
      const date = new Date(year, month - 1, day, hour, minute, second);
      if (Number.isNaN(date.getTime()) || date.getFullYear() !== year || date.getMonth() !== month - 1
        || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) return null;
      return date;
    }
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function dateTimestamp(value) {
    const date = parseDate(value);
    return date ? date.getTime() : 0;
  }

  function isRecentDate(value, recentDays, nowValue) {
    const date = parseDate(value);
    const now = parseDate(nowValue) || new Date();
    if (!date) return false;
    const elapsedDays = (now.getTime() - date.getTime()) / 86400000;
    return elapsedDays >= -1 && elapsedDays <= Math.max(1, Number(recentDays) || 30);
  }

  function recordCompare(a, b) {
    const revision = revisionRank(b.revision) - revisionRank(a.revision);
    if (revision) return revision;
    const source = (Number(b.sourceTimestamp) || 0) - (Number(a.sourceTimestamp) || 0);
    if (source) return source;
    // Algumas LDs mantêm uma aba antiga oculta (por exemplo, "N-1710") e
    // publicam a relação vigente em outra aba da mesma família ("N-1710 MOD").
    // A aba visível deve prevalecer, sem perder a consulta às linhas históricas.
    const visibility = Number(Boolean(a.sheetHidden)) - Number(Boolean(b.sheetHidden));
    if (visibility) return visibility;
    const richness = (item) => [
      item && item.title, item && item.discipline, item && item.purpose,
      item && item.allocation, item && item.allocationStatus, item && item.grdt,
      item && item.effectiveDate, item && item.databook,
    ].reduce((score, value) => score + Number(Boolean(text(value))), 0);
    const completeness = richness(b) - richness(a);
    if (completeness) return completeness;
    const effective = dateTimestamp(b.effectiveDate) - dateTimestamp(a.effectiveDate);
    if (effective) return effective;
    const grdt = Number(Boolean(text(b.grdt))) - Number(Boolean(text(a.grdt)));
    if (grdt) return grdt;
    return (Number(b.row) || 0) - (Number(a.row) || 0);
  }

  function historyCompare(a, b) {
    const modified = dateTimestamp(b.modified) - dateTimestamp(a.modified);
    if (modified) return modified;
    const included = dateTimestamp(b.included) - dateTimestamp(a.included);
    if (included) return included;
    return (Number(b.row) || 0) - (Number(a.row) || 0);
  }

  function compactTimestamp(value) {
    const date = value instanceof Date ? value : new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) return "";
    return date.toISOString().slice(0, 23).replace(/\D/g, "");
  }

  function findHeader(rows) {
    const limit = Math.min(rows.length, 100);
    for (let i = 0; i < limit; i += 1) {
      const mapped = columnMap(rows[i] || []);
      if (mapped.document !== undefined && (mapped.revision !== undefined || mapped.status !== undefined || mapped.sigemStatus !== undefined)) return i;
    }
    return -1;
  }

  function normalizedHeader(value) {
    return norm(value)
      .replace(/N[º°]/g, "NUMERO")
      .replace(/[^A-Z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function allocationStatusHeaderScore(value) {
    const h = normalizedHeader(value);
    if (!h) return 0;
    const confirmation = h.includes("CONFIRMACAO");
    const document = h.includes("DOCUMENTO");
    const expected = h.includes("PREVISTO");
    const allocation = h.includes("ALOCACAO");
    if (confirmation && document && expected) return 1200;
    if (document && expected && /\bALOCAD/.test(h)) return 1160;
    if (confirmation && document) return 1120;
    if (/\b(NUMERO|NRO|CODIGO|IDENTIFICADOR|ETAPA|FASE|DATA|SOLICITACAO|ARQUIVO)\b/.test(h)) return 0;
    if (confirmation && allocation) return 1080;
    if (h === "ALOCACAO CONFIRMADA") return 1060;
    if (h.includes("ACEITE") && allocation) return 1000;
    if (/^(STATUS|SITUACAO|CONDICAO) (DE|DA) ALOCACAO$/.test(h)) return 980;
    if (/^(ALOCADO|DOCUMENTO ALOCADO|STATUS ALOCADO)$/.test(h)) return 940;
    return 0;
  }

  function allocationNumberHeaderScore(value) {
    const h = normalizedHeader(value);
    if (!h || allocationStatusHeaderScore(h)) return 0;
    if (/\b(ETAPA|FASE|STATUS|SITUACAO|CONDICAO|CONFIRMACAO|ACEITE|DATA)\b/.test(h)) return 0;
    if (/\b(NUMERO|NRO|CODIGO|IDENTIFICADOR)\b/.test(h) && h.includes("ALOCACAO")) return 1100;
    if (h === "ALOCACAO") return 1050;
    if (h.includes("ALOCACAO")) return 900;
    return 0;
  }

  // Coluna de TAG da LD. Nem toda aba tem uma; quando tem, ela é a origem
  // preferencial do TAG no cruzamento com o Apêndice 3. "TAXONOMIA" e afins não
  // são TAG e ficam de fora.
  function tagHeaderScore(value) {
    const h = normalizedHeader(value);
    if (!h) return 0;
    if (h === "TAG") return 1200;
    if (/^TAG(?: DO| DA| DE)? /.test(h) && !h.includes("TAXONOMIA")) return 1100;
    if (/^(NUMERO|CODIGO) (DA |DO )?TAG$/.test(h)) return 1050;
    if (/\bTAG\b/.test(h) && (h.includes("EQUIPAMENTO") || h.includes("ITEM") || h.includes("BEM"))) return 900;
    return 0;
  }

  function columnMap(header) {
    const result = {};
    const allocationStatusCandidates = [];
    const allocationNumberCandidates = [];
    const tagCandidates = [];
    header.forEach((cell, index) => {
      const h = norm(cell);
      if (!h) return;
      const statusScore = allocationStatusHeaderScore(cell);
      const numberScore = allocationNumberHeaderScore(cell);
      if (statusScore) allocationStatusCandidates.push({ index, score: statusScore });
      if (numberScore) allocationNumberCandidates.push({ index, score: numberScore });
      if (h === "DOCUMENTO" || h.startsWith("DOCUMENTO ") || h === "CODIGO DOCUMENTO" || h === "CODIGO DO DOCUMENTO" || h === "NUMERO DOCUMENTO" || h === "IDENTIFICADOR DOCUMENTO") result.document = index;
      else if (h === "REVISAO" || h === "REV." || h === "REV") result.revision = index;
      else if (h === "VERSAO DA LD ENVIADA" || h.includes("VERSAO DA LD ENVIADA")) result.ldVersion = index;
      else if (h.includes("STATUS SIGEM")) result.sigemStatus = index;
      else if (h === "STATUS") result.status = index;
      else if (h === "TITULO" || h.includes("TITULO DO DOCUMENTO")) result.title = index;
      else if (h === "GRDT" || h.includes("NUMERO GRDT")) result.grdt = index;
      else if (h.includes("DATA EFETIVA DE EMISSAO")) result.effectiveDate = index;
      else if (h === "FORMATO") result.format = index;
      else if (h === "DISCIPLINA" || h.includes("DISCIPLINA/WORKFLOW") || h.includes("DISCIPLINA / WORKFLOW") || h.startsWith("DISCIPLINA ")) result.discipline = index;
      else if (h.includes("TIPO DE DOCUMENTO") || h === "TIPO DOCUMENTO") result.documentType = index;
      else if (h.includes("PROPOSITO") || h.includes("FINALIDADE")) result.purpose = index;
      else if (h.includes("CAMINHO DATABOOK") || h.includes("CAMINHO DATA BOOK")) result.databook = index;
      else if (h.includes("COMENTARIO DA FISCAL")) result.fiscalComment = index;
      else if (h.includes("ETAPA") && h.includes("ALOCACAO")) result.allocationStage = index;
      else if (tagHeaderScore(cell)) tagCandidates.push({ index, score: tagHeaderScore(cell) });
      else if (h.includes("MODIFICADO EM")) result.modified = index;
      else if (h.includes("INCLUIDO EM")) result.included = index;
    });
    const best = (items) => items.sort((left, right) => right.score - left.score || right.index - left.index)[0];
    const status = best(allocationStatusCandidates);
    const allocation = best(allocationNumberCandidates);
    const tag = best(tagCandidates);
    if (status) result.allocationStatus = status.index;
    if (allocation) result.allocation = allocation.index;
    if (tag) result.tag = tag.index;
    return result;
  }

  function inferPurposeColumn(sheet, headerIndex, range, columns) {
    if (columns.purpose !== undefined) return columns.purpose;
    const occupied = new Set(Object.values(columns).filter(Number.isInteger));
    const candidates = sheetColumnsInRows(sheet, headerIndex + 1, Math.min(range.e.r, headerIndex + 240), range)
      .filter((column) => !occupied.has(column));
    const official = new Map(EGRDT_OPTIONS.purposes.map((purpose) => [norm(purpose), purpose]));
    let best = null;
    candidates.forEach((column) => {
      let recognized = 0;
      let filled = 0;
      for (let row = headerIndex + 1; row <= Math.min(range.e.r, headerIndex + 240); row += 1) {
        const value = sheetCell(sheet, row, column);
        if (!value) continue;
        filled += 1;
        if (official.has(norm(value))) recognized += 1;
      }
      if (recognized < 2) return;
      const ratio = recognized / Math.max(1, filled);
      const score = recognized * 10 + ratio;
      if (ratio >= 0.6 && (!best || score > best.score)) best = { column, score };
    });
    return best ? best.column : undefined;
  }

  function cell(row, index) {
    return index === undefined ? "" : text(row[index]);
  }

  function sheetCell(sheet, row, column) {
    if (column === undefined) return "";
    const item = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
    if (!item) return "";
    return text(item.w !== undefined ? item.w : item.v);
  }

  function sheetDateCell(sheet, row, column) {
    if (column === undefined) return "";
    const item = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
    if (!item) return "";
    const value = item.v;
    const date = value instanceof Date ? value : (typeof value === "number" ? parseDate(value) : null);
    if (date) {
      // O SheetJS pode deslocar datas de planilhas antigas por alguns segundos
      // ao aplicar fusos horários históricos. O texto formatado da célula mantém
      // o dia exibido no Excel; usamos a interpretação mais próxima do valor
      // interno para resolver automaticamente formatos DD/MM e MM/DD.
      const formatted = text(item.w);
      const parts = formatted.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})(?:\D|$)/);
      if (parts) {
        let formattedYear = Number(parts[3]);
        if (formattedYear < 100) formattedYear += 2000;
        const first = Number(parts[1]);
        const second = Number(parts[2]);
        const candidates = [[first, second], [second, first]].map(([day, month]) => {
          const candidate = new Date(formattedYear, month - 1, day);
          return candidate.getFullYear() === formattedYear && candidate.getMonth() === month - 1 && candidate.getDate() === day
            ? { candidate, year: formattedYear, month, day }
            : null;
        }).filter(Boolean).sort((left, right) => Math.abs(left.candidate.getTime() - date.getTime()) - Math.abs(right.candidate.getTime() - date.getTime()));
        if (candidates.length) {
          const chosen = candidates[0];
          return `${chosen.year}-${String(chosen.month).padStart(2, "0")}-${String(chosen.day).padStart(2, "0")}`;
        }
      }
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }
    return text(value !== undefined ? value : item.w);
  }

  function revisionToken(value) {
    const candidate = text(value).toUpperCase().replace(/\s+/g, "");
    return /^(?:0|[A-HJ-NP-Z](?:\d{1,3})?)$/.test(candidate) ? candidate : "";
  }

  function inferLdVersionFromSourceName(sourceName) {
    const raw = text(sourceName).replace(/\.(?:XLSX?|XLSM)$/i, "");
    const explicit = raw.match(/(?:VERS(?:AO|ÃO)|REV(?:ISAO|ISÃO)?)[ _.-]*([A-HJ-NP-Z]|0)(?:\b|_)/i);
    if (explicit) return revisionToken(explicit[1]);
    const controlled = raw.match(/_\d{4}_([A-HJ-NP-Z]|0)(?:\b|[_ (.-])/i);
    return controlled ? revisionToken(controlled[1]) : "";
  }

  function inferLdVersion(workbook) {
    const coverName = (workbook.SheetNames || []).find((sheetName) => norm(sheetName) === "CAPA");
    const sheet = coverName ? workbook.Sheets[coverName] : null;
    if (!sheet || !sheet["!ref"]) return "";
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    const maxRow = Math.min(range.e.r, range.s.r + 80);
    const maxCol = Math.min(range.e.c, range.s.c + 32);
    const headers = [];
    for (let row = range.s.r; row <= maxRow; row += 1) {
      for (let col = range.s.c; col <= maxCol; col += 1) {
        const label = norm(sheetCell(sheet, row, col));
        if (["REV", "REV.", "REVISAO", "VERSAO DA LD", "REVISAO DA LD"].includes(label)) headers.push({ row, col });
      }
    }
    const primary = [];
    const secondary = [];
    headers.forEach(({ row, col }) => {
      for (let offset = 1; offset <= 180 && row + offset <= range.e.r; offset += 1) {
        const token = revisionToken(sheetCell(sheet, row + offset, col));
        if (!token) continue;
        if (/^(?:0|[A-HJ-NP-Z])$/.test(token)) primary.push(token);
        else secondary.push(token);
      }
      const side = revisionToken(sheetCell(sheet, row, col + 1));
      if (side) (/^(?:0|[A-HJ-NP-Z])$/.test(side) ? primary : secondary).push(side);
    });
    return primary.at(-1) || secondary.at(-1) || "";
  }

  function sheetColumnsInRows(sheet, startRow, endRow, range) {
    const columns = new Set();
    Object.keys(sheet || {}).forEach((address) => {
      if (!address || address[0] === "!") return;
      let decoded;
      try { decoded = XLSX.utils.decode_cell(address); } catch (_) { return; }
      if (decoded.r >= startRow && decoded.r <= endRow) columns.add(decoded.c);
    });
    (sheet && sheet["!merges"] || []).forEach((merge) => {
      if (merge.e.r < startRow || merge.s.r > endRow) return;
      for (let column = merge.s.c; column <= merge.e.c; column += 1) columns.add(column);
    });
    if (!columns.size && range) {
      for (let column = range.s.c; column <= range.e.c; column += 1) columns.add(column);
    }
    return [...columns].sort((left, right) => left - right);
  }

  function readHeaderRow(sheet, row, columns) {
    const header = [];
    (columns || []).forEach((column) => { header[column] = sheetCell(sheet, row, column); });
    return header;
  }

  function parseWorkbook(workbook, sourceName, sourceTimestamp, compatibilityProfile) {
    const records = [];
    const history = [];
    const fallbackLdVersion = inferLdVersionFromSourceName(sourceName) || inferLdVersion(workbook);
    const mappedFields = { technical: new Set(), history: new Set() };
    const configuredSheets = compatibilityProfile && compatibilityProfile.sheets || null;
    const ignoredSheets = new Set(["CAPA", "T", "G", "PLANILHA1", "ALOCACAO"]);
    (workbook.SheetNames || []).forEach((sheetName, sheetOrder) => {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet || !sheet["!ref"]) return;
      const configured = configuredSheets && configuredSheets[sheetName];
      if (configuredSheets && (!configured || configured.role === "ignore")) return;
      const range = XLSX.utils.decode_range(sheet["!ref"]);
      let headerIndex = configured && Number.isInteger(configured.headerRow) ? configured.headerRow : -1;
      let header = [];
      if (headerIndex >= 0) {
        const configuredColumns = Object.values(configured && configured.columns || {}).filter(Number.isInteger);
        const populatedColumns = sheetColumnsInRows(sheet, headerIndex, headerIndex, range);
        header = readHeaderRow(sheet, headerIndex, [...new Set([...populatedColumns, ...configuredColumns])]);
      } else {
        const endRow = Math.min(range.e.r, range.s.r + 99);
        const populatedColumns = sheetColumnsInRows(sheet, range.s.r, endRow, range);
        for (let r = range.s.r; r <= endRow; r += 1) {
          const candidate = readHeaderRow(sheet, r, populatedColumns);
          const mapped = columnMap(candidate);
          if (mapped.document !== undefined && (mapped.revision !== undefined || mapped.status !== undefined || mapped.sigemStatus !== undefined)) {
            headerIndex = r;
            header = candidate;
            break;
          }
        }
      }
      if (headerIndex < 0) return;
      const columns = configured && configured.columns ? { ...configured.columns } : columnMap(header);
      if (columns.document === undefined) return;
      const inferredPurpose = inferPurposeColumn(sheet, headerIndex, range, columns);
      if (columns.purpose === undefined && inferredPurpose !== undefined) columns.purpose = inferredPurpose;
      const historySheet = configured ? configured.role === "history" : norm(sheetName) === "COLAR SIGEM";
      if (!historySheet && ignoredSheets.has(norm(sheetName))) return;
      const sheetMetadata = (workbook.Workbook && workbook.Workbook.Sheets || []).find((item) => text(item && item.name) === sheetName);
      const sheetHidden = Number(sheetMetadata && sheetMetadata.Hidden) || 0;
      Object.keys(columns).forEach((field) => mappedFields[historySheet ? "history" : "technical"].add(field));
      for (let i = headerIndex + 1; i <= range.e.r; i += 1) {
        const document = sheetCell(sheet, i, columns.document);
        if (!document || norm(document) === "FIM") continue;
        const documentKey = key(document);
        if (documentKey.length < 7) continue;
        const rowLdVersion = columns.ldVersion === undefined
          ? fallbackLdVersion
          : sheetCell(sheet, i, columns.ldVersion);
        const item = {
          document,
          documentKey,
          queryKey: sheetCell(sheet, i, 0),
          revision: sheetCell(sheet, i, columns.revision),
          status: sheetCell(sheet, i, columns.status),
          sigemStatus: sheetCell(sheet, i, columns.sigemStatus),
          title: sheetCell(sheet, i, columns.title),
          grdt: sheetCell(sheet, i, columns.grdt),
          effectiveDate: sheetDateCell(sheet, i, columns.effectiveDate),
          format: sheetCell(sheet, i, columns.format),
          discipline: sheetCell(sheet, i, columns.discipline),
          documentType: sheetCell(sheet, i, columns.documentType),
          purpose: sheetCell(sheet, i, columns.purpose),
          databook: sheetCell(sheet, i, columns.databook),
          fiscalComment: sheetCell(sheet, i, columns.fiscalComment),
          allocationStatus: sheetCell(sheet, i, columns.allocationStatus),
          allocationStatusHeader: columns.allocationStatus === undefined ? "" : text(header[columns.allocationStatus]).replace(/\s+/g, " "),
          allocationStatusColumn: columns.allocationStatus === undefined ? "" : XLSX.utils.encode_col(columns.allocationStatus),
          allocationStatusState: allocationState(sheetCell(sheet, i, columns.allocationStatus)),
          allocationStage: sheetCell(sheet, i, columns.allocationStage),
          modified: sheetCell(sheet, i, columns.modified),
          included: sheetCell(sheet, i, columns.included),
          allocation: sheetCell(sheet, i, columns.allocation),
          tag: columns.tag === undefined ? "" : sheetCell(sheet, i, columns.tag),
          tagHeader: columns.tag === undefined ? "" : text(header[columns.tag]).replace(/\s+/g, " "),
          tagColumn: columns.tag === undefined ? "" : XLSX.utils.encode_col(columns.tag),
          sheet: sheetName.trim(),
          row: i + 1,
          source: sourceName,
          sourceTimestamp: Number(sourceTimestamp) || 0,
          sourceOrder: sheetOrder,
          sheetHidden,
          ldVersion: rowLdVersion,
          ldVersionHeader: columns.ldVersion === undefined ? "" : text(header[columns.ldVersion]).replace(/\s+/g, " "),
          ldVersionColumn: columns.ldVersion === undefined ? "" : XLSX.utils.encode_col(columns.ldVersion),
          ldVersionSource: columns.ldVersion === undefined ? "fallback" : "VERSÃO DA LD ENVIADA",
          ldColumns: header.map((label, column) => ({
            header: text(label).replace(/\s+/g, " "),
            value: sheetCell(sheet, i, column),
          })).filter((entry) => entry.header),
        };
        const normalizedItem = Contracts ? Contracts.normalizeRecord(item) : item;
        if (historySheet) history.push(normalizedItem);
        else records.push(normalizedItem);
      }
    });
    return {
      records,
      history,
      ldVersion: fallbackLdVersion,
      mappedFields: {
        technical: [...mappedFields.technical],
        history: [...mappedFields.history],
      },
      compatibilityProfile: compatibilityProfile || null,
    };
  }

  function buildIndex(records, history) {
    const byDocument = new Map();
    const byDocumentRevision = new Map();
    records.forEach((item) => {
      const documentKey = key(item.documentKey || item.document);
      if (!byDocument.has(documentKey)) byDocument.set(documentKey, { records: [], history: [] });
      byDocument.get(documentKey).records.push(item);
    });
    history.forEach((item) => {
      const documentKey = key(item.documentKey || item.document);
      if (!byDocument.has(documentKey)) byDocument.set(documentKey, { records: [], history: [] });
      byDocument.get(documentKey).history.push(item);
      const revision = normalizeRevision(item.revision);
      if (revision) {
        const historyKey = `${documentKey}::${revision}`;
        if (!byDocumentRevision.has(historyKey)) byDocumentRevision.set(historyKey, []);
        byDocumentRevision.get(historyKey).push(item);
      }
    });
    // A linha técnica da LD é a fonte de verdade também para a grafia. O
    // histórico só fornece um representante quando o documento não possui
    // linha técnica. Assim, caixa, "nt-" e separadores nunca são herdados de
    // uma escrita antiga do histórico.
    const controlledRepresentative = (group) => {
      const technical = (group && group.records || []).filter((item) => text(item && item.document));
      const candidates = technical.length ? technical : (group && group.history || []).filter((item) => text(item && item.document));
      return candidates.reduce((best, item) => !best || text(item.document).length > text(best.document).length ? item : best, null);
    };
    const documents = [...byDocument.entries()]
      .map(([documentKey, group]) => {
        const representative = controlledRepresentative(group);
        return { documentKey, document: representative && representative.document || documentKey, group, searchKeys: documentSearchKeys(documentKey) };
      })
      .sort((a, b) => b.documentKey.length - a.documentKey.length);
    byDocumentRevision.forEach((items) => items.sort(historyCompare));
    // Índice paralelo ignorando o "nt-": é ele que permite achar o documento
    // quando o arquivo grafa o código de um jeito e a LD de outro.
    const byNtNeutral = new Map();
    const byEtTagFormat = new Map();
    const byEtTagConfusable = new Map();
    const byEtReportTag = new Map();
    const byEtReportTagConfusable = new Map();
    documents.forEach((entry) => {
      if (!isEtDocument(entry.documentKey)) return;
      const neutro = ntNeutralKey(entry.documentKey);
      if (!byNtNeutral.has(neutro)) byNtNeutral.set(neutro, []);
      byNtNeutral.get(neutro).push(entry);
      const tag = etTagComparable(entry.documentKey);
      if (!tag) return;
      if (!byEtTagFormat.has(tag.formatKey)) byEtTagFormat.set(tag.formatKey, []);
      byEtTagFormat.get(tag.formatKey).push(entry);
      if (!byEtTagConfusable.has(tag.confusableKey)) byEtTagConfusable.set(tag.confusableKey, []);
      byEtTagConfusable.get(tag.confusableKey).push(entry);
      if (!byEtReportTag.has(tag.reportTagKey)) byEtReportTag.set(tag.reportTagKey, []);
      byEtReportTag.get(tag.reportTagKey).push(entry);
      if (!byEtReportTagConfusable.has(tag.reportTagConfusableKey)) byEtReportTagConfusable.set(tag.reportTagConfusableKey, []);
      byEtReportTagConfusable.get(tag.reportTagConfusableKey).push(entry);
    });
    return { byDocument, byDocumentRevision, documents, byNtNeutral, byEtTagFormat, byEtTagConfusable, byEtReportTag, byEtReportTagConfusable };
  }

  /** Índice por chave sem "nt-", montado uma vez e reaproveitado. */
  function ntNeutralEntries(index) {
    if (index && index.byNtNeutral) return index.byNtNeutral;
    const mapa = new Map();
    ((index && index.documents) || []).forEach((entry) => {
      if (!isEtDocument(entry.documentKey)) return;
      const neutro = ntNeutralKey(entry.documentKey);
      if (!mapa.has(neutro)) mapa.set(neutro, []);
      mapa.get(neutro).push(entry);
    });
    if (index) {
      try { Object.defineProperty(index, "byNtNeutral", { value: mapa, enumerable: false, configurable: true }); }
      catch (_) { index.byNtNeutral = mapa; }
    }
    return mapa;
  }

  function etTagEntries(index) {
    if (index && index.byEtTagFormat && index.byEtTagConfusable) {
      return { format: index.byEtTagFormat, confusable: index.byEtTagConfusable };
    }
    const format = new Map();
    const confusable = new Map();
    ((index && index.documents) || []).forEach((entry) => {
      const tag = isEtDocument(entry.documentKey) && etTagComparable(entry.documentKey);
      if (!tag) return;
      if (!format.has(tag.formatKey)) format.set(tag.formatKey, []);
      format.get(tag.formatKey).push(entry);
      if (!confusable.has(tag.confusableKey)) confusable.set(tag.confusableKey, []);
      confusable.get(tag.confusableKey).push(entry);
    });
    if (index) {
      try {
        Object.defineProperty(index, "byEtTagFormat", { value: format, enumerable: false, configurable: true });
        Object.defineProperty(index, "byEtTagConfusable", { value: confusable, enumerable: false, configurable: true });
      } catch (_) {
        index.byEtTagFormat = format;
        index.byEtTagConfusable = confusable;
      }
    }
    return { format, confusable };
  }

  function tagVariantMatches(value, index) {
    const tag = etTagComparable(value);
    if (!tag) return [];
    const entries = etTagEntries(index);
    const exactFormat = (entries.format.get(tag.formatKey) || [])
      .filter((entry) => entry.documentKey !== key(value))
      .map((entry) => ({ ...entry, matchedSearchKey: key(value), matchKind: "tag-format-variant", tagVariant: true }));
    if (exactFormat.length) return exactFormat;
    return (entries.confusable.get(tag.confusableKey) || [])
      .filter((entry) => entry.documentKey !== key(value) && etTagVariantKind(value, entry.documentKey) === "tag-transcription-variant")
      .map((entry) => ({ ...entry, matchedSearchKey: key(value), matchKind: "tag-transcription-variant", tagVariant: true }));
  }

  /**
   * Última busca ET: preserva obrigatoriamente o tipo documental do Grupo 6 e
   * compara o TAG normalizado. Os Grupos 1 a 5 podem ser corrigidos pelo código
   * controlado da LD, mas REP nunca pode casar com RUFF (nem qualquer outro tipo
   * com outro), ainda que o TAG seja idêntico.
   */
  function reportTagMatches(value, index) {
    const tag = etTagComparable(value);
    if (!tag) return [];
    let exactEntries = index && index.byEtReportTag;
    let confusableEntries = index && index.byEtReportTagConfusable;
    if (!exactEntries || !confusableEntries) {
      exactEntries = new Map();
      confusableEntries = new Map();
      ((index && index.documents) || []).forEach((entry) => {
        const candidateTag = isEtDocument(entry.documentKey) && etTagComparable(entry.documentKey);
        if (!candidateTag) return;
        if (!exactEntries.has(candidateTag.reportTagKey)) exactEntries.set(candidateTag.reportTagKey, []);
        exactEntries.get(candidateTag.reportTagKey).push(entry);
        if (!confusableEntries.has(candidateTag.reportTagConfusableKey)) confusableEntries.set(candidateTag.reportTagConfusableKey, []);
        confusableEntries.get(candidateTag.reportTagConfusableKey).push(entry);
      });
      if (index) {
        try {
          Object.defineProperty(index, "byEtReportTag", { value: exactEntries, enumerable: false, configurable: true });
          Object.defineProperty(index, "byEtReportTagConfusable", { value: confusableEntries, enumerable: false, configurable: true });
        } catch (_) {
          index.byEtReportTag = exactEntries;
          index.byEtReportTagConfusable = confusableEntries;
        }
      }
    }
    const exact = (exactEntries.get(tag.reportTagKey) || [])
      .filter((entry) => entry.documentKey !== key(value))
      .map((entry) => ({
        ...entry,
        matchedSearchKey: key(value),
        matchKind: "report-tag",
        reportTag: true,
        searchedTag: tag.identifier,
        searchedReportCode: tag.reportCode,
      }));
    if (exact.length) return exact;
    return (confusableEntries.get(tag.reportTagConfusableKey) || [])
      .filter((entry) => {
        if (entry.documentKey === key(value)) return false;
        const candidateTag = etTagComparable(entry.documentKey);
        return candidateTag
          && candidateTag.reportCode === tag.reportCode
          && singleConfusableDifference(tag.compact, candidateTag.compact);
      })
      .map((entry) => ({
        ...entry,
        matchedSearchKey: key(value),
        matchKind: "report-tag-transcription",
        reportTag: true,
        searchedTag: tag.identifier,
        searchedReportCode: tag.reportCode,
      }));
  }

  function exactDocumentMatch(value, index) {
    if (!index || !index.byDocument) return null;
    const documentKey = key(value);
    const group = index.byDocument.get(documentKey);
    if (group) {
      const technical = (group.records || []).filter((item) => text(item && item.document));
      const candidates = technical.length ? technical : (group.history || []).filter((item) => text(item && item.document));
      const representative = candidates.reduce((best, item) => !best || text(item.document).length > text(best.document).length ? item : best, null);
      return { documentKey, document: representative && representative.document || text(value), group, matchedSearchKey: documentKey, matchKind: "exact" };
    }
    if (!isEtDocument(documentKey)) return null;
    // Não achou como veio: procura a mesma chave ignorando o "nt-". A consulta
    // é num índice paralelo, e não uma varredura da LD, porque isto roda uma
    // vez por arquivo e por linha da relação.
    const variantes = (ntNeutralEntries(index).get(ntNeutralKey(documentKey)) || [])
      .filter((item) => item.documentKey !== documentKey && isEtDocument(item.document));
    if (variantes.length === 1) return { ...variantes[0], matchedSearchKey: documentKey, matchKind: "nt-variant", ntVariant: true };
    if (variantes.length > 1) return null;
    const tagVariants = tagVariantMatches(documentKey, index);
    if (tagVariants.length) return tagVariants.length === 1 ? tagVariants[0] : null;
    const tagMatches = reportTagMatches(documentKey, index);
    return tagMatches.length === 1 ? tagMatches[0] : null;
  }

  function containsDocumentKey(inputKey, documentKey) {
    let position = inputKey.indexOf(documentKey);
    while (position >= 0) {
      const before = position > 0 ? inputKey[position - 1] : "";
      const afterPosition = position + documentKey.length;
      const after = afterPosition < inputKey.length ? inputKey[afterPosition] : "";
      if ((!before || !/[A-Z0-9]/.test(before)) && (!after || !/[A-Z0-9]/.test(after))) return true;
      position = inputKey.indexOf(documentKey, position + 1);
    }
    return false;
  }

  function isForbiddenN1710NtAlias(inputKey, candidate) {
    if (!candidate || !isN1710Context("", candidate.document)) return false;
    return containsDocumentKey(inputKey, `NT-${candidate.documentKey}`);
  }

  // Um código só pode casar se começar e terminar em uma fronteira — antes e
  // depois dele não pode haver letra ou número. Isso limita os trechos possíveis
  // do nome do arquivo aos pedaços delimitados por separadores, que são poucos.
  // Enumerar esses pedaços e procurá-los no índice dá o mesmo resultado de
  // varrer a LD inteira, só que sem depender do tamanho dela.
  const MAX_FRONTEIRAS = 40;

  function boundaryPositions(inputKey) {
    const inicios = [0];
    const fins = [];
    for (let i = 0; i < inputKey.length; i += 1) {
      if (/[A-Z0-9]/.test(inputKey[i])) continue;
      fins.push(i);
      inicios.push(i + 1);
    }
    fins.push(inputKey.length);
    return { inicios, fins };
  }

  function candidatesByIndexLookup(inputKey, index) {
    if (!index.byDocument || !index.documents) return null;
    const { inicios, fins } = boundaryPositions(inputKey);
    // Texto muito picotado (uma colagem inteira, por exemplo) faria a
    // combinação de fronteiras crescer demais; nesse caso a varredura antiga
    // continua sendo o caminho mais previsível.
    if (inicios.length > MAX_FRONTEIRAS || fins.length > MAX_FRONTEIRAS) return null;
    if (!index.positionByKey) {
      const posicoes = new Map();
      index.documents.forEach((item, ordem) => {
        if (!posicoes.has(item.documentKey)) posicoes.set(item.documentKey, { item, ordem });
      });
      try { Object.defineProperty(index, "positionByKey", { value: posicoes, enumerable: false, configurable: true }); }
      catch (_) { index.positionByKey = posicoes; }
    }
    const encontrados = new Map();
    inicios.forEach((inicio) => {
      fins.forEach((fim) => {
        // documentKey com menos de 7 caracteres nunca entra no índice.
        if (fim - inicio < 7) return;
        const trecho = inputKey.slice(inicio, fim);
        const achado = index.positionByKey.get(trecho);
        if (achado && !isForbiddenN1710NtAlias(inputKey, achado.item) && !encontrados.has(trecho)) encontrados.set(trecho, achado);
      });
    });
    return [...encontrados.values()]
      .sort((a, b) => a.ordem - b.ordem)
      .map((entrada) => ({ ...entrada.item, matchedSearchKey: entrada.item.documentKey, matchKind: "exact" }));
  }

  /**
   * Última tentativa, só quando nada foi encontrado: procura o mesmo código
   * ignorando o "nt-". Vale apenas para ET — documento de N-1710 não tem "nt-"
   * no código, então um casamento assim ali seria coincidência, não o mesmo
   * documento.
   */
  function ntVariantCandidates(inputKey, index) {
    if (!index.documents) return [];
    if (!isEtDocument(inputKey)) return [];
    ntNeutralEntries(index);
    const { inicios, fins } = boundaryPositions(inputKey);
    if (inicios.length > MAX_FRONTEIRAS || fins.length > MAX_FRONTEIRAS) return [];
    const achados = new Map();
    inicios.forEach((inicio) => {
      fins.forEach((fim) => {
        if (fim - inicio < 7) return;
        const trecho = inputKey.slice(inicio, fim);
        const neutro = ntNeutralKey(trecho);
        // Só interessa quando o "nt-" é justamente a diferença.
        if (neutro === trecho && !index.byNtNeutral.has(neutro)) return;
        (index.byNtNeutral.get(neutro) || []).forEach((entry) => {
          if (entry.documentKey === trecho) return;
          if (!isEtDocument(entry.document)) return;
          if (achados.has(entry.documentKey)) return;
          achados.set(entry.documentKey, { ...entry, ntVariant: true, matchedSearchKey: trecho, matchKind: "nt-variant" });
        });
      });
    });
    return [...achados.values()];
  }

  function tagVariantCandidates(inputKey, index) {
    if (!index.documents || !isEtDocument(inputKey)) return [];
    const { inicios, fins } = boundaryPositions(inputKey);
    if (inicios.length > MAX_FRONTEIRAS || fins.length > MAX_FRONTEIRAS) return [];
    const formats = new Map();
    const confusables = new Map();
    inicios.forEach((inicio) => {
      fins.forEach((fim) => {
        if (fim - inicio < 7) return;
        const trecho = inputKey.slice(inicio, fim);
        tagVariantMatches(trecho, index).forEach((entry) => {
          const target = entry.matchKind === "tag-format-variant" ? formats : confusables;
          if (!target.has(entry.documentKey)) target.set(entry.documentKey, entry);
        });
      });
    });
    return [...(formats.size ? formats : confusables).values()];
  }

  function reportTagCandidates(inputKey, index) {
    if (!index.documents || !isEtDocument(inputKey)) return [];
    const { inicios, fins } = boundaryPositions(inputKey);
    if (inicios.length > MAX_FRONTEIRAS || fins.length > MAX_FRONTEIRAS) return [];
    const achados = new Map();
    inicios.forEach((inicio) => {
      fins.forEach((fim) => {
        if (fim - inicio < 7) return;
        const trecho = inputKey.slice(inicio, fim);
        reportTagMatches(trecho, index).forEach((entry) => {
          if (!achados.has(entry.documentKey)) achados.set(entry.documentKey, entry);
        });
      });
    });
    return [...achados.values()];
  }

  function matchDocuments(nameOrText, index, hintedSheet) {
    const exact = exactDocumentMatch(nameOrText, index);
    if (exact) return [exact];
    const inputKey = canonicalId(nameOrText);
    const hint = norm(hintedSheet);
    // A varredura de index.documents é o caminho de reserva: ela custa o
    // produto arquivos × linhas da LD, o que numa LD de 15.000 linhas pesa. O
    // caminho normal procura no índice os trechos do nome delimitados por
    // separadores, que é a única posição em que um código pode casar.
    let candidates = candidatesByIndexLookup(inputKey, index) || index.documents.filter((item) => (
      containsDocumentKey(inputKey, item.documentKey) && !isForbiddenN1710NtAlias(inputKey, item)
    )).map((item) => ({ ...item, matchedSearchKey: item.documentKey, matchKind: "exact" }));
    if (!candidates.length) candidates = ntVariantCandidates(inputKey, index);
    if (!candidates.length) candidates = tagVariantCandidates(inputKey, index);
    if (!candidates.length) candidates = reportTagCandidates(inputKey, index);
    if (!candidates.length) return [];
    const preferredCandidates = candidates.some((candidate) => candidate.matchKind === "exact")
      ? candidates.filter((candidate) => candidate.matchKind === "exact")
      : candidates;
    const maximalCandidates = preferredCandidates.filter((candidate) => !preferredCandidates.some((other) => (
      other !== candidate
      && other.matchedSearchKey.length > candidate.matchedSearchKey.length
      && other.matchedSearchKey.includes(candidate.matchedSearchKey)
    )));
    if (hint) {
      const inSheet = maximalCandidates.filter((candidate) => candidate.group.records.some((r) => sheetMatchesHint(r.sheet, hint)));
      if (inSheet.length) return inSheet;
    }
    return maximalCandidates;
  }

  function matchDocument(nameOrText, index, hintedSheet) {
    return matchDocuments(nameOrText, index, hintedSheet)[0] || null;
  }

  // A ET de codificação de currículos define a família CV em cinco grupos.
  // A própria norma traz exemplos históricos com sequencial de 3 dígitos,
  // embora o texto prescreva 4. A LD é a fonte controlada; por isso a triagem
  // aceita 3 ou 4 dígitos para localizar a aba CV e gerar a eGRDT, sem
  // confundir com outras famílias documentais.
  const CV_DOCUMENT_RE = /^5900(?:\.\d+){3}-[A-Z0-9]{3}-CV-[A-Z0-9]+-\d{3,4}$/i;

  function isCvDocument(value, sheetName) {
    if (norm(sheetName) === "CV") return true;
    const raw = canonicalId(text(value).replace(/\.(?:PDF|DOCX?|XLSX?|XLSM|DWG|DGN|PPTX?)$/i, ""));
    return CV_DOCUMENT_RE.test(raw);
  }

  function inferSheetFromName(fileName) {
    const baseName = text(fileName).split(/[\\/]/).pop();
    const name = canonicalId(baseName.replace(/\.[A-Z0-9]{1,5}$/i, ""));
    const cvCandidate = name.match(/^5900(?:\.\d+){3}-[A-Z0-9]{3}-CV-[A-Z0-9]+-\d{3,4}/i);
    if (cvCandidate && isCvDocument(cvCandidate[0])) return "CV";
    if (/^[A-Z0-9]{3}_RNEST_[A-Z0-9]+_\d+(?:\.\d+){3}_[A-Z0-9]+_[A-Z0-9][A-Z0-9.-]*_/.test(name)) return "ET";
    const first = name.split("-")[0];
    const category = /^[IAFLED]$/.test(first) ? name.split("-")[1] : first;
    if (N1710_CATEGORIES.has(category) && name.includes("-5290.00-")) return "N-1710";
    return "";
  }

  function controlArtifactKind(fileName) {
    const name = norm(fileName);
    if (!name) return "arquivo sem nome";
    if (/^~\$/.test(name)) return "arquivo temporário do Office";
    if (/(?:^|[ _-])E?GRDT(?:[ _.(-]|$)/.test(name)) return "arquivo de controle GRDT";
    if (/^(RELATORIO[ _-](?:TRIAGEM|GRCON)|DADOS[ _-]EGRDT|PACOTE[ _-](?:DOCUMENTOS[ _-]PRONTOS|GRCON))/.test(name)) return "saída gerada pelo aplicativo";
    return "";
  }

  function claimedRevisionFromName(fileName, document) {
    const stem = text(fileName).replace(/\.[^.]+$/, "");
    const escaped = text(document).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let tail = stem;
    if (document && new RegExp(escaped, "i").test(stem)) tail = stem.replace(new RegExp(`^.*?${escaped}`, "i"), "");
    const patterns = [
      /_0001[_ -](?:REV[_ -]?)?([A-Z]{1,3}\d*|0)$/i,
      /[_ -]REV(?:ISAO)?[_ -]?([A-Z]{1,3}\d*|0)$/i,
      /[_ -]([A-Z]{1,3}\d*|0)$/i,
    ];
    for (const pattern of patterns) {
      const m = tail.match(pattern);
      if (m) return normalizeRevision(m[1]);
    }
    return "";
  }

  function revisionFromName(fileName, document) {
    const claim = claimedRevisionFromName(fileName, document);
    return revisionInfo(claim).valid ? claim : "";
  }

  function revisionFromText(pdfText, document) {
    const value = canonicalId(pdfText);
    const documentKey = canonicalId(document);
    let scope = value;
    if (documentKey) {
      const position = value.indexOf(documentKey);
      if (position < 0) return "";
      scope = value.slice(Math.max(0, position - 180), position + documentKey.length + 260);
    }
    const patterns = [
      /REVISAO\s*[:\-]?\s*([A-HJ-NP-Z]{1,3}|0)\b/g,
      /\bREV\.?\s*[:\-]?\s*([A-HJ-NP-Z]{1,3}|0)\b/g,
      /\bREVISION\s*[:\-]?\s*([A-HJ-NP-Z]{1,3}|0)\b/g,
      /_0001[_ -]([A-HJ-NP-Z]{1,3}|0)\b/g,
    ];
    const revisions = [];
    for (const pattern of patterns) {
      for (const match of scope.matchAll(pattern)) {
        const revision = normalizeRevision(match[1]);
        if (revisionInfo(revision).valid) revisions.push(revision);
      }
    }
    const unique = [...new Set(revisions)];
    if (documentKey) return unique.length === 1 ? unique[0] : "";
    return unique[0] || "";
  }

  function reportGroup7Info(document) {
    const raw = text(document).replace(/\.(?:PDF|DOCX?|XLSX?|XLSM|DWG|DGN|PPTX?)$/i, "");
    const groups = raw.split("_");
    const isReport = groups.length >= 7 && norm(groups[1]) === "RNEST";
    const identifier = isReport ? groups.slice(6).join("_").trim() : "";
    const exactNonTag = identifier.startsWith("nt-");
    const startsNonTag = /^nt(?:-|_)/i.test(identifier);
    const nonTagCaseMismatch = startsNonTag && !exactNonTag;
    return {
      raw,
      groups,
      isReport,
      identifier,
      isNonTagged: startsNonTag,
      exactNonTagged: exactNonTag,
      nonTagCaseMismatch,
      tag: isReport && identifier && !startsNonTag ? identifier : "",
    };
  }

  function validateDocumentCode(document, sheetName) {
    const raw = text(document);
    const sheet = norm(sheetName);
    const errors = [];
    if (!raw) return { valid: false, family: sheet, errors: ["Código documental vazio."] };

    if (sheet === "ET" || raw.includes("_RNEST_")) {
      const group7 = reportGroup7Info(raw);
      const groups = group7.groups;
      if (groups.length !== 7) errors.push("Relatório deve possuir exatamente 7 grupos separados por underline; o Grupo 7 começa após o 6º underline.");
      if (groups[1] && norm(groups[1]) !== "RNEST") errors.push("Grupo 2 do relatório deve ser RNEST.");
      if (groups[3] && !/^\d+(?:\.\d+){3}$/.test(groups[3])) errors.push("EAP do relatório deve possuir quatro níveis numéricos.");
      if (groups[4] && !REPORT_DISCIPLINES.has(norm(groups[4]))) errors.push("Disciplina do relatório não consta na lista contratual.");
      if (!group7.identifier) errors.push("Grupo 7 vazio: informe a TAG ou o identificador não tagueado iniciado por nt-.");
      if (group7.nonTagCaseMismatch) errors.push("Item não tagueado deve começar exatamente por nt- minúsculo.");
      if (group7.identifier && /[_ç?|!@#$%¨&*(),\s]/i.test(group7.identifier)) errors.push("Grupo 7 (TAG/identificador) contém caractere proibido pela ET.");
      return { valid: errors.length === 0, family: "ET", errors, group7 };
    }

    if (sheet === "CV" || isCvDocument(raw)) {
      if (!isCvDocument(raw)) {
        errors.push("Currículo não atende aos cinco grupos previstos na ET (instrumento contratual, emissor, CV, disciplina e sequencial).");
      }
      return { valid: errors.length === 0, family: "CV", errors };
    }

    const groups = raw.split("-");
    const hasLanguage = groups.length > 0 && /^[IAFLED]$/i.test(groups[0]);
    const category = norm(groups[hasLanguage ? 1 : 0]);
    const expectedGroups = hasLanguage ? 7 : 6;
    if (groups.length !== expectedGroups) errors.push(`Documento deve possuir ${expectedGroups} grupos neste caso.`);
    if (!N1710_CATEGORIES.has(category)) errors.push("Categoria documental não consta na lista contratual.");
    const installation = groups[hasLanguage ? 2 : 1] || "";
    if (installation !== "5290.00") errors.push("Instalação deve ser 5290.00 para a Refinaria do Nordeste neste contrato.");
    const area = groups[hasLanguage ? 3 : 2] || "";
    if (!/^\d{4,5}$/.test(area)) errors.push("Grupo de área/sistema deve possuir quatro dígitos ou diferenciador mais quatro dígitos.");
    const documentClass = groups[hasLanguage ? 4 : 3] || "";
    if (!/^[A-Z0-9]{3}$/i.test(documentClass)) errors.push("Código do grupo 4 deve possuir três caracteres alfanuméricos.");
    const origin = groups[hasLanguage ? 5 : 4] || "";
    if (norm(origin) !== "C1O") errors.push("Origem documental deve ser C1O para a CONSAG neste contrato.");
    const sequence = groups[hasLanguage ? 6 : 5] || "";
    if (!/^\d{3,4}$/.test(sequence)) errors.push("Sequencial deve possuir três ou quatro dígitos.");
    return { valid: errors.length === 0, family: "N-1710", errors };
  }

  function optionValue(value, options) {
    const wanted = norm(value);
    return options.find((item) => norm(item) === wanted) || "";
  }

  function inferDiscipline(document, record) {
    const direct = optionValue(record && record.discipline, EGRDT_OPTIONS.disciplines);
    if (direct) return direct;
    const source = norm(record && record.discipline);
    const sourceParts = source.split("/").map((part) => part.trim()).filter(Boolean);
    const sourceTail = sourceParts[sourceParts.length - 1] || source;
    const sourcePrefix = sourceParts.length > 1 ? sourceParts[sourceParts.length - 2] : "";
    const officialByPrefix = [...EGRDT_OPTIONS.disciplines]
      .sort((a, b) => norm(b).length - norm(a).length)
      .find((option) => sourcePrefix.includes(norm(option)));
    if (officialByPrefix) return officialByPrefix;
    const officialByTail = [...EGRDT_OPTIONS.disciplines]
      .sort((a, b) => norm(b).length - norm(a).length)
      .find((option) => sourceTail === norm(option) || sourceTail.includes(norm(option)));
    if (officialByTail) return officialByTail;
    const officialInSource = [...EGRDT_OPTIONS.disciplines]
      .sort((a, b) => norm(b).length - norm(a).length)
      .find((option) => norm(option).length >= 5 && source.includes(norm(option)));
    if (officialInSource) return officialInSource;
    const textMap = [
      ["TUBUL", "TUBULAÇÃO"], ["CIVIL", "CIVIL"], ["ELETR", "ELÉTRICA"],
      ["INSTRUMENT", "INSTRUMENTAÇÃO"], ["DINAM", "DINÂMICOS"], ["ESTATIC", "ESTÁTICOS"],
      ["MECAN", "MECÂNICA"], ["QUALIDADE", "QUALIDADE"], ["PLANEJ", "PLANEJAMENTO"],
      ["COMISSION", "COMISSIONAMENTO"], ["SUPRIMENT", "SUPRIMENTOS"],
      ["COORDEN", "COORDENAÇÃO"], ["SEGURAN", "SEGURANÇA"], ["SAUDE", "SAÚDE"],
      ["MEIO AMBIENTE", "MEIO AMBIENTE"], ["ADM CONTRATUAL", "ADM CONTRATUAL"],
      ["COMUNICACAO", "COMUNICAÇÃO E RS"], ["RESPONSABILIDADE SOCIAL", "COMUNICAÇÃO E RS"],
      ["FERRAMENTAS COMPUTACIONAIS", "FERRAMENTAS COMPUTACIONAIS"], ["MONTAGEM", "MONTAGEM"],
      ["TELECOM", "COMUNICAÇÃO E RS"], ["PROJETO", "ENGENHARIA DE PROJETO"], ["GERAL", "GERAL"],
    ];
    const byText = textMap.find(([token]) => source.includes(token));
    if (byText) return byText[1];
    const groups = text(document).split("_");
    const cvCode = text(document).match(/-CV-([A-Z0-9]+)-/i);
    const code = norm(cvCode ? cvCode[1] : groups[4]);
    const codeMap = {
      CVL: "CIVIL", ELE: "ELÉTRICA", INS: "INSTRUMENTAÇÃO", DIN: "DINÂMICOS",
      EST: "ESTÁTICOS", MEC: "MECÂNICA", PLA: "PLANEJAMENTO", QUA: "QUALIDADE",
      SEG: "SEGURANÇA", SUP: "SUPRIMENTOS", TUB: "TUBULAÇÃO", CDR: "COORDENAÇÃO",
      CRS: "COMUNICAÇÃO E RS", ADC: "ADM CONTRATUAL", PRJ: "ENGENHARIA DE PROJETO",
      SMS: "SEGURANÇA", TEL: "COMUNICAÇÃO E RS", GER: "GERAL", MON: "MONTAGEM",
    };
    return codeMap[code] || "";
  }

  function inferDocumentType(document, record, sheetName) {
    const direct = optionValue(record && record.documentType, EGRDT_OPTIONS.documentTypes);
    if (direct) return direct;
    const sheet = norm(sheetName);
    if (sheet === "ET" || text(document).includes("_RNEST_")) return "RL";
    if (sheet === "CV" || isCvDocument(document)) return "CV";
    const groups = text(document).split("-");
    const category = /^[IAFLED]$/i.test(groups[0]) ? groups[1] : groups[0];
    return optionValue(category, EGRDT_OPTIONS.documentTypes);
  }

  function buildEgrdtData(document, revision, finalName, record, sheetName, pdfFormat) {
    return {
      document: text(document),
      revision: normalizeRevision(revision),
      title: text(record && record.title),
      fileName: text(finalName),
      format: optionValue((record && record.format) || pdfFormat, EGRDT_OPTIONS.formats),
      discipline: inferDiscipline(document, record || {}),
      documentType: inferDocumentType(document, record || {}, sheetName),
      purpose: optionValue(record && record.purpose, EGRDT_OPTIONS.purposes),
      databook: text(record && record.databook),
    };
  }

  function validateEgrdtData(data) {
    const errors = [];
    if (!text(data.document)) errors.push("DOCUMENTO vazio");
    if (!revisionInfo(data.revision).valid) errors.push("REVISÃO inválida");
    if (!text(data.title)) errors.push("TÍTULO vazio");
    if (!text(data.fileName) || !/\.[A-Z0-9]{2,8}$/i.test(text(data.fileName))) errors.push("ARQUIVO sem extensão");
    if (!EGRDT_OPTIONS.formats.includes(text(data.format))) errors.push("FORMATO fora da lista oficial");
    if (!EGRDT_OPTIONS.disciplines.includes(text(data.discipline))) errors.push("DISCIPLINA fora da lista oficial");
    if (!EGRDT_OPTIONS.documentTypes.includes(text(data.documentType))) errors.push("TIPO DE DOCUMENTO fora da lista oficial");
    if (!EGRDT_OPTIONS.purposes.includes(text(data.purpose))) errors.push("PROPÓSITO fora da lista oficial");
    return errors;
  }

  function chooseBestRecord(group, hintedSheet) {
    const hint = norm(hintedSheet);
    let records = group.records || [];
    if (hint) {
      const filtered = records.filter((r) => sheetMatchesHint(r.sheet, hint));
      if (!filtered.length && records.length) {
        return { record: null, ambiguous: false, sheetMismatch: true, candidates: records };
      }
      records = filtered;
    }
    if (!records.length) return { record: null, ambiguous: false, sheetMismatch: false, candidates: [] };
    records = [...records].sort(recordCompare);
    const sheets = [...new Set(records.map((item) => norm(item.sheet)))];
    if (!hint && sheets.length > 1) return { record: null, ambiguous: true, candidates: records };

    // Diferenças históricas de título, caminho Databook ou número de alocação
    // não tornam a linha atual ambígua. O detector de conflitos já interrompe a
    // análise quando existem valores incompatíveis que alteram a decisão na
    // mesma revisão. Fora desses casos, usamos a linha controlada mais recente.
    return { record: records[0], ambiguous: false, sheetMismatch: false, candidates: records };
  }

  function statusEvidence(group, revision, hintedSheet) {
    const rev = norm(revision);
    const hint = norm(hintedSheet);
    const all = [...(group.history || []), ...(group.records || [])];
    return all.filter((item) => {
      if (normalizeRevision(item.revision) !== rev) return false;
      if (hint && item.sheet && !norm(item.sheet).includes("SIGEM") && !sheetMatchesHint(item.sheet, hint)) return false;
      return true;
    }).map((item) => ({
      status: item.sigemStatus || item.status,
      source: item.source,
      sheet: item.sheet,
      revision: item.revision,
      item,
    })).filter((item) => text(item.status));
  }

  function recordForRevision(group, revision, hintedSheet) {
    const hint = norm(hintedSheet);
    let records = (group.records || []).filter((item) => normalizeRevision(item.revision) === normalizeRevision(revision));
    if (hint) {
      const sameSheet = records.filter((item) => sheetMatchesHint(item.sheet, hint));
      if (sameSheet.length) records = sameSheet;
    }
    return records.length === 1 ? records[0] : null;
  }

  function evidenceLocation(item, role) {
    if (!item) return null;
    return {
      role: text(role),
      source: text(item.source),
      sheet: text(item.sheet),
      row: Number(item.row) || 0,
      revision: normalizeRevision(item.revision),
      grdt: text(item.grdt),
      effectiveDate: text(item.effectiveDate),
    };
  }

  function analysisEvidenceForRevision(group, revision, hintedSheet, statusInfo) {
    const statusItem = statusInfo && statusInfo.item || null;
    const statusHasEmissionFields = Boolean(text(statusItem && statusItem.grdt) || text(statusItem && statusItem.effectiveDate));
    const hint = norm(hintedSheet);
    let technicalCandidates = (group.records || [])
      .filter((item) => normalizeRevision(item.revision) === normalizeRevision(revision));
    if (hint) {
      const sameSheet = technicalCandidates.filter((item) => sheetMatchesHint(item.sheet, hint));
      if (sameSheet.length) technicalCandidates = sameSheet;
    }
    technicalCandidates = [...technicalCandidates].sort(recordCompare);

    // Títulos diferentes entre linhas antigas e atuais não são evidência de conflito.
    // Para Em Análise, só há conflito quando duas linhas da mesma revisão trazem
    // GRDT/data efetiva preenchidas e realmente incompatíveis.
    const emissionSignatures = new Set(technicalCandidates
      .filter((item) => text(item.grdt) || text(item.effectiveDate))
      .map((item) => {
        const parsed = parseDate(item.effectiveDate);
        const dateKey = parsed
          ? `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`
          : norm(item.effectiveDate);
        return `${norm(item.grdt)}|${dateKey}`;
      }));
    const technicalEvidenceConflict = emissionSignatures.size > 1;
    const valueItem = statusHasEmissionFields ? statusItem : technicalCandidates[0] || null;
    return {
      item: valueItem,
      statusSource: evidenceLocation(statusItem, "Status SIGEM"),
      emissionSource: evidenceLocation(valueItem, statusHasEmissionFields ? "GRDT e data da Colar SIGEM" : "GRDT e data da linha técnica"),
      sourceKind: statusHasEmissionFields ? "history" : valueItem ? "technical" : "missing",
      conflict: !statusHasEmissionFields && technicalEvidenceConflict,
      candidates: statusHasEmissionFields ? [statusItem] : technicalCandidates,
    };
  }

  function formatDateBR(value) {
    const parsed = parseDate(value);
    if (!parsed || Number.isNaN(parsed.getTime())) return text(value);
    return `${String(parsed.getDate()).padStart(2, "0")}/${String(parsed.getMonth() + 1).padStart(2, "0")}/${parsed.getFullYear()}`;
  }

  function technicalPostingEvidenceForRevision(group, revision, hintedSheet) {
    const hint = norm(hintedSheet);
    let candidates = (group.records || []).filter((item) => normalizeRevision(item.revision) === normalizeRevision(revision));
    if (hint) {
      const sameSheet = candidates.filter((item) => sheetMatchesHint(item.sheet, hint));
      if (sameSheet.length) candidates = sameSheet;
    }
    candidates = [...candidates].sort(recordCompare);
    const evidence = candidates.map((item) => {
      const grdt = text(item.grdt);
      const effectiveDate = text(item.effectiveDate);
      const parsedDate = parseDate(effectiveDate);
      return {
        item,
        grdt,
        effectiveDate,
        parsedDate,
        complete: Boolean(grdt && parsedDate),
        partial: Boolean((grdt || effectiveDate) && !(grdt && parsedDate)),
        source: text(item.source),
        sheet: text(item.sheet),
        row: Number(item.row) || 0,
      };
    });
    const complete = evidence.filter((item) => item.complete);
    const partial = evidence.filter((item) => item.partial);
    const signatures = new Set(complete.map((item) => `${norm(item.grdt)}|${item.parsedDate.getFullYear()}-${item.parsedDate.getMonth()+1}-${item.parsedDate.getDate()}`));
    const selected = complete[0] || partial[0] || null;
    if (!selected) return { status: "SEM EVIDÊNCIA DE POSTAGEM NA LD", complete: false, partial: false, conflict: false, explanation: "A linha da revisão não possui GRDT nem Data Efetiva de Emissão preenchidas." };
    if (signatures.size > 1) return { ...selected, status: "CONFLITO NA EVIDÊNCIA DE POSTAGEM", complete: false, partial: false, conflict: true, explanation: "Existem linhas da mesma revisão com números de GRDT ou datas efetivas diferentes." };
    if (selected.complete) return { ...selected, status: "POSTADO CONFORME LD", explanation: `A LD informa a GRDT ${selected.grdt} e a Data Efetiva de Emissão ${formatDateBR(selected.effectiveDate)} na mesma linha.` };
    return { ...selected, status: "EVIDÊNCIA DE POSTAGEM INCOMPLETA", explanation: selected.grdt ? `A LD informa a GRDT ${selected.grdt}, mas a Data Efetiva de Emissão está vazia ou inválida.` : `A LD informa a Data Efetiva de Emissão ${formatDateBR(selected.effectiveDate)}, mas o número da GRDT está vazio.` };
  }

  function statusForRevision(group, revision) {
    const rev = normalizeRevision(revision);
    const history = (group.history || [])
      .filter((item) => normalizeRevision(item.revision) === rev)
      .sort((a, b) => (Number(a.row) || 0) - (Number(b.row) || 0));
    if (history.length) {
      const rawStatuses = history.map((item) => text(item.sigemStatus || item.status));
      const statuses = [...new Set(rawStatuses.filter(Boolean).map(norm))];
      if (rawStatuses.some((status) => !status)) {
        return { status: "Status vazio na Colar SIGEM", item: null, source: "SIGEM", conflict: false, incomplete: true, candidates: history };
      }
      if (statuses.length > 1) {
        return { status: "Conflito na Colar SIGEM", item: null, source: "SIGEM", conflict: true, incomplete: false, candidates: history };
      }
      if (!statuses.length) {
        return { status: "Status vazio na Colar SIGEM", item: null, source: "SIGEM", conflict: false, incomplete: true, candidates: history };
      }
      return { status: text(history[0].sigemStatus || history[0].status), item: history[0], source: "SIGEM", conflict: false, incomplete: false };
    }
    return { status: "Não Postado", item: null, source: "ausência de DOCUMENTO-REVISÃO na Colar SIGEM", conflict: false, incomplete: false };
  }

  /**
   * Documentos da N-1710 seguem regra própria de nome. Vale tanto quando a ABA
   * da LD identifica a N-1710 (ex.: "LD 001 N-1710") quanto quando o próprio
   * código do documento já indica isso.
   */
  function isN1710Context(sheetName, document) {
    const aba = norm(sheetName).replace(/[^A-Z0-9]/g, "");
    if (aba.includes("N1710")) return true;
    return inferSheetFromName(`${text(document)}.pdf`) === "N-1710";
  }

  function proposedFileName(inputName, document, revision, sheetName) {
    const ext = /\.[^.]+$/.exec(text(inputName));
    const extension = ext ? ext[0].toLowerCase() : ".pdf";
    const originalStem = text(inputName).replace(/\.[^.]+$/, "");
    const revisionPattern = "(?:0|[A-HJ-NP-Z]+)";
    const sequenceExpression = new RegExp(`_0001(?:[_ -](?:REV[_ -]?)?${revisionPattern})?$`, "i");
    const trailingExpression = new RegExp(`[_ -](?:REV(?:ISAO)?[_ -]?)?${revisionPattern}$`, "i");
    const hasSequence = sequenceExpression.test(originalStem);
    const withoutRevision = originalStem.replace(trailingExpression, "");
    const originalDocument = originalStem.replace(sequenceExpression, "");
    const changedOnlyByNtPrefix = key(originalDocument) === key(ntPrefixVariant(document));
    let base = hasSequence
      ? changedOnlyByNtPrefix ? `${document}_0001` : originalStem.replace(sequenceExpression, "_0001")
      : document;
    if (!hasSequence && key(withoutRevision) === key(document)) base = withoutRevision;
    if (!base) base = originalStem.replace(trailingExpression, "");
    // Quando o arquivo grafa o código com "nt-" e a LD sem (ou o contrário), o
    // nome final segue a LD: é assim que o documento está alocado e é assim que
    // o SIGEM vai aceitar. Sem isto o arquivo manteria a grafia de origem.
    const stemBase = hasSequence ? originalStem.replace(sequenceExpression, "") : withoutRevision;
    const inputTag = etTagComparable(stemBase);
    const ldTag = etTagComparable(document);
    const sameEtReportTag = Boolean(
      inputTag
      && ldTag
      && inputTag.reportCode === ldTag.reportCode
      && (inputTag.compact === ldTag.compact || singleConfusableDifference(inputTag.compact, ldTag.compact))
    );
    if (document && key(stemBase) !== key(document)
        && (ntNeutralKey(stemBase) === ntNeutralKey(document) || etTagVariantKind(stemBase, document) || sameEtReportTag)) {
      base = hasSequence ? `${document}_0001` : document;
    }
    const n1710 = isN1710Context(sheetName, document);
    if (n1710 && !/_0001$/i.test(base)) base = `${document}_0001`;
    const r = normalizeRevision(revision);
    // Na N-1710 o SIGEM só aceita com a revisão sempre presente depois do
    // _0001, inclusive quando ela é 0 (…_0001_0). Nos demais documentos, como
    // a ET, a revisão 0 continua sendo omitida.
    if (n1710) return `${base}_${r || "0"}${extension}`;
    return `${base}${r && r !== "0" ? `_${r}` : ""}${extension}`;
  }

  function validateFinalFileName(fileName, originalName, document, revision, sheetName) {
    const expected = proposedFileName(originalName || fileName, document, revision, sheetName);
    const validName = canonicalId(fileName) === canonicalId(expected);
    const normalizedRevision = normalizeRevision(revision);
    const detectedRevision = claimedRevisionFromName(fileName, document);
    // Na N-1710 a revisão 0 tem de aparecer no nome; nos demais ela é omitida.
    const revisionValid = isN1710Context(sheetName, document)
      ? detectedRevision === (normalizedRevision || "0")
      : (normalizedRevision === "0" ? detectedRevision === "" : detectedRevision === normalizedRevision);
    return {
      valid: validName && revisionValid,
      expected,
      detectedRevision,
      revision: normalizedRevision,
      errors: [
        ...(validName ? [] : [`Nome final divergente; esperado ${expected}.`]),
        ...(revisionValid ? [] : [`O sufixo do arquivo não representa a revisão ${normalizedRevision}.`]),
      ],
    };
  }

  function enrichDecision(row, reasonCode) {
    return Contracts ? Contracts.enrichDecision(row, reasonCode) : row;
  }

  /**
   * Descobre que o código foi informado de uma forma e a LD o tem de outra —
   * diferindo só pelo "nt-". A relação usa isto para mostrar, lado a lado, o
   * que foi entregue e com que nome o documento vai entrar na eGRDT.
   */
  function ntRenameInfo(input, document, finalName) {
    const naLd = text(document);
    if (!naLd || naLd === "Não localizado") return null;
    // Nas relações Excel o documento lógico já pode ter sido substituído pela
    // grafia oficial da LD antes da triagem. Preserve a identidade originalmente
    // informada, registrada no documentLookup, para que o relatório mostre o
    // DE → PARA correto mesmo quando o PDF físico não foi fornecido.
    const enviado = text(input && (
      input.documentLookup && input.documentLookup.inputDocument
      || input.documentLookupHint && input.documentLookupHint.inputDocument
      || input.document
      || input.name
    ));
    if (!enviado) return null;
    const alvo = canonicalId(enviado);
    const chave = key(naLd);
    if (!chave || alvo.includes(chave)) return null;
    if (!ntNeutralKey(alvo).includes(ntNeutralKey(chave))) return null;
    const arquivoTemNt = /(^|[^A-Z0-9])NT-/.test(alvo);
    return {
      enviado,
      naLd,
      finalName: text(finalName),
      direcao: arquivoTemNt ? "informado com nt-, LD sem nt-" : "informado sem nt-, LD com nt-",
      nota: `Localizado na LD ${arquivoTemNt ? "sem o “nt-”" : "com “nt-”"}. Você informou ${enviado}; na LD o documento está como ${naLd}${text(finalName) ? `, e vai entrar na eGRDT como ${text(finalName)}` : ""}. O nome segue a LD porque é assim que o documento está alocado no SIGEM.`,
    };
  }

  function applyNtRename(result, input) {
    const info = ntRenameInfo(input, result.document, result.finalName);
    if (!info) return result;
    result.ntVariant = true;
    result.ntRename = info;
    result.reason = `${text(result.reason)} ${info.nota}`.trim();
    return result;
  }

  function tagRenameInfo(input, document, finalName) {
    const lookup = input && (input.documentLookup || input.documentLookupHint) || {};
    if (!lookup.matchedByReportTag && !lookup.matchedByTagVariant) return null;
    const enviado = text(lookup.inputDocument || input && (input.document || input.name));
    const naLd = text(document || lookup.ldDocument);
    if (!enviado || !naLd || key(enviado) === key(naLd)) return null;
    return {
      enviado,
      naLd,
      finalName: text(finalName),
      motivo: "tipo+tag",
      nota: `O código completo não foi localizado, mas a combinação tipo “${text(lookup.searchedReportCode)}” + TAG “${text(lookup.searchedTag)}” identificou uma única linha compatível na LD. Você informou ${enviado}; na LD o documento está como ${naLd}${text(finalName) ? `, e vai entrar na eGRDT como ${text(finalName)}` : ""}. O nome final segue obrigatoriamente o código controlado da LD.`,
    };
  }

  function applyOfficialCodeRename(result, input) {
    const withNtRename = applyNtRename(result, input);
    if (withNtRename.ntRename) return withNtRename;
    const info = tagRenameInfo(input, withNtRename.document, withNtRename.finalName);
    if (!info) return withNtRename;
    withNtRename.ldRename = info;
    withNtRename.reason = `${text(withNtRename.reason)} ${info.nota}`.trim();
    return withNtRename;
  }

  function reviewResult(input, values) {
    const item = values || {};
    const result = {
      ...input,
      id: input.id,
      document: item.document || input.document || "Não localizado",
      documentKey: item.documentKey || "",
      sheet: item.sheet || "",
      sheetSource: item.sheetSource || "não identificada",
      revision: normalizeRevision(item.revision),
      revisionSource: item.revisionSource || "não confirmada",
      status: item.status || "Não consta na LD",
      decision: REVIEW,
      reason: item.reason || "A informação precisa de conferência manual.",
      finalName: item.finalName || input.name || "arquivo.pdf",
      grdt: item.grdt || "",
      effectiveDate: item.effectiveDate || "",
      recentEmission: false,
      databook: item.databook || "",
      evidence: item.evidence || [],
      postingEvidence: item.postingEvidence || (item.record ? technicalPostingEvidenceForRevision({ records: [item.record] }, item.revision, item.sheet) : null),
      postingStatus: item.postingStatus || (item.postingEvidence && item.postingEvidence.status) || (item.record ? technicalPostingEvidenceForRevision({ records: [item.record] }, item.revision, item.sheet).status : "SEM EVIDÊNCIA DE POSTAGEM NA LD"),
      record: item.record || {},
      codeValidation: item.codeValidation || { valid: false, errors: [] },
      egrdt: item.egrdt || {},
      allocationStatus: item.allocationStatus || "",
      allocationFinding: item.allocationFinding || null,
      fiscalComment: item.fiscalComment || "",
      documentSource: item.documentSource || input.documentSource || "nome do arquivo",
      hardBlock: Boolean(item.hardBlock),
      blockCode: item.blockCode || "",
      reasonCode: item.reasonCode || "",
      ldConflict: item.ldConflict || null,
      ntVariant: false,
      ntRename: null,
      ldRename: null,
    };
    return enrichDecision(applyOfficialCodeRename(result, input), item.reasonCode);
  }

  function triageOne(input, index, options) {
    const settings = options || {};
    const recentDays = Math.max(1, Number(settings.recentDays) || 30);
    const nowValue = settings.now || new Date();
    const inferredSheet = input.hintedSheet || inferSheetFromName(input.name || input.document || "");
    const identitySource = input.document ? "documento informado" : "nome do arquivo";
    const identityValue = input.document || input.name || "";
    const matches = matchDocuments(identityValue, index, inferredSheet);
    const calculatedDocumentLookup = documentLookup(
      identityValue,
      matches.length === 1 ? matches[0] : null,
      matches
    );
    input.documentLookup = input.documentLookupHint && (input.documentLookupHint.matched || !matches.length)
      ? input.documentLookupHint
      : calculatedDocumentLookup;
    if (matches.length > 1) {
      const codes = matches.slice(0, 5).map((candidate) => candidate.document).join("; ");
      return reviewResult(input, {
        document: input.document || "Não localizado",
        sheet: inferredSheet,
        sheetSource: inferredSheet ? "prefixo do arquivo" : "não identificada",
        revision: revisionFromName(input.name || "", input.document || "") || "",
        status: "Código ambíguo no nome",
        reason: `O nome do arquivo contém mais de um código controlado (${codes}). Nenhuma associação automática foi feita.`,
        finalName: input.name || "arquivo.pdf",
        documentSource: identitySource,
      });
    }
    const match = matches[0] || null;
    if (!match) {
      return reviewResult(input, {
        document: input.document || "Não localizado",
        sheet: inferredSheet,
        sheetSource: inferredSheet ? "prefixo do arquivo" : "não identificada",
        revision: revisionFromName(input.name || "", input.document || "") || "",
        status: "Não consta na LD",
        reason: `${input.documentLookup.message} O texto interno do PDF não é usado para substituir a identidade informada pelo nome.`,
        finalName: input.name || "arquivo.pdf",
        documentSource: identitySource,
      });
    }

    let group = match.group;
    const conflictCore = typeof globalThis !== "undefined" && globalThis.LDConflictCore
      ? globalThis.LDConflictCore
      : (typeof module === "object" && module.exports ? require("./ld_conflicts.js") : null);
    const resolutionId = settings.conflictResolutions && typeof settings.conflictResolutions.get === "function"
      ? settings.conflictResolutions.get(match.documentKey)
      : settings.conflictResolutionId;
    const ldConflict = conflictCore && conflictCore.analyzeGroup
      ? conflictCore.analyzeGroup(group, { hintedSheet: inferredSheet, resolutionId })
      : null;
    const groupAllocationConflict = allocationConflictSummary(group && group.records);
    if (groupAllocationConflict.anyNegative) {
      const blocked = groupAllocationConflict.states
        .filter((entry) => entry.state.kind === "not_allocated")
        .map((entry) => entry.item);
      const allocated = groupAllocationConflict.states
        .filter((entry) => entry.state.kind === "allocated")
        .map((entry) => entry.item);
      const blockedComments = [...new Set(blocked.map((item) => text(item && item.fiscalComment)).filter(Boolean))].join(" | ");

      // A LD respondendo as duas coisas para o mesmo documento é um conflito, e
      // não uma não alocação. Dizer "Não alocado" aqui contradizia a própria LD:
      // quem abria a planilha via a linha ALOCADO, com número de ALOC, e o
      // relatório afirmava o contrário. Pior, a evidência apontava para a
      // primeira linha negativa encontrada — quase nunca a linha atual.
      if (groupAllocationConflict.mixed) {
        const atual = mostRecentRecord(group && group.records) || blocked[0] || {};
        const alocada = mostRecentRecord(allocated) || {};
        const negada = mostRecentRecord(blocked) || {};
        const numeroAlocacao = text(alocada.allocation);
        return reviewResult(input, {
          document: match.document,
          documentKey: match.documentKey,
          sheet: text(atual.sheet) || inferredSheet,
          sheetSource: inferredSheet ? "prefixo do arquivo" : "LD",
          revision: normalizeRevision(atual.revision) || revisionFromName(input.name || "", match.document),
          status: "Alocação conflitante na LD",
          reason: [
            "A LD traz duas respostas para este documento e o GRCON não escolhe entre elas.",
            `Diz ALOCADO em ${recordLocation(alocada) || "uma das linhas"}${numeroAlocacao ? `, com a alocação ${numeroAlocacao}` : ", sem número de alocação"}.`,
            `Diz NÃO ALOCADO em ${recordLocation(negada) || "outra linha"}${text(negada.allocation) ? `, com a alocação ${text(negada.allocation)}` : ", sem número de alocação"}.`,
            "Confirme qual linha vale antes de postar. Enquanto isso o documento fica fora da eGRDT automática; a inclusão manual continua disponível.",
            blockedComments ? `Comentário da Fiscal: ${blockedComments}.` : "",
          ].filter(Boolean).join(" "),
          finalName: proposedFileName(input.name || `${match.document}.pdf`, match.document, normalizeRevision(atual.revision), text(atual.sheet) || inferredSheet),
          documentSource: identitySource,
          allocationStatus: "CONFLITO — a LD registra ALOCADO e NÃO ALOCADO",
          allocationFinding: {
            kind: "conflict",
            label: "A LD registra ALOCADO e NÃO ALOCADO para o mesmo documento",
            evidence: "conflict",
            source: `${recordLocation(alocada) || "linha alocada"} × ${recordLocation(negada) || "linha não alocada"}`,
            tracked: true,
            status: "CONFLITO",
            allocationNumber: numeroAlocacao,
            sheet: text(atual.sheet),
            column: text(atual.allocationStatusColumn),
            header: text(atual.allocationStatusHeader),
            row: Number(atual.row) || 0,
          },
          fiscalComment: blockedComments || text(atual.fiscalComment),
          // A linha usada para título, revisão, GRDT e Databook é a atual da LD,
          // não a primeira linha negativa que aparecer na varredura.
          record: atual,
          evidence: [...allocated, ...blocked].map((item) => ({
            status: text(item.allocationStatus),
            source: item.source,
            sheet: item.sheet,
            revision: item.revision,
            row: item.row,
            item,
          })),
          codeValidation: validateDocumentCode(match.document, text(atual.sheet) || inferredSheet),
          ldConflict,
          hardBlock: true,
          blockCode: "not_allocated_conflict",
          reasonCode: Contracts ? Contracts.CODES.ALLOCATION_CONFLICT : "ALLOCATION_CONFLICT",
        });
      }

      const firstBlocked = mostRecentRecord(blocked) || {};
      // "NÃO ALOCADO com número de ALOC" e "NÃO ALOCADO sem número" são
      // situações diferentes do mesmo bloqueio: na primeira a ALOC já foi
      // enviada e o que falta é o retorno da fiscal. Chamar as duas de "Não
      // alocado" fazia quem lê a LD — onde o número da ALOC está preenchido —
      // achar que o GRCON contradizia a planilha.
      const alocEnviada = allocationNumberInfo(firstBlocked.allocation);
      const aguardandoRetorno = alocEnviada.valid;
      return reviewResult(input, {
        document: match.document,
        documentKey: match.documentKey,
        sheet: text(firstBlocked.sheet) || inferredSheet,
        sheetSource: inferredSheet ? "prefixo do arquivo" : "LD",
        revision: normalizeRevision(firstBlocked.revision) || revisionFromName(input.name || "", match.document),
        status: aguardandoRetorno ? "Aguardando retorno da alocação" : "Não alocado",
        reason: aguardandoRetorno
          ? `A alocação ${alocEnviada.raw} está registrada na LD, mas a confirmação continua “NÃO ALOCADO”${recordLocation(firstBlocked) ? ` em ${recordLocation(firstBlocked)}` : ""} — a ALOC foi enviada e o retorno ainda não veio. Enquanto a confirmação não mudar, a postagem permanece bloqueada.${blockedComments ? ` Comentário da Fiscal: ${blockedComments}.` : ""}`
          : `A coluna de confirmação de alocação contém “NÃO ALOCADO”${recordLocation(firstBlocked) ? ` em ${recordLocation(firstBlocked)}` : ""}, sem número de alocação registrado. Esta condição é bloqueante e não pode ser substituída por outra linha, por resolução manual ou por evidência histórica.${blockedComments ? ` Comentário da Fiscal: ${blockedComments}.` : ""}`,
        finalName: input.name || `${match.document}.pdf`,
        documentSource: identitySource,
        allocationStatus: "NÃO ALOCADO",
        allocationFinding: {
          ...allocationEvidenceState(firstBlocked),
          label: aguardandoRetorno
            ? `Não alocado — ALOC ${alocEnviada.raw} enviada, aguardando retorno`
            : "Não alocado",
          awaitingReturn: aguardandoRetorno,
          status: text(firstBlocked.allocationStatus) || "NÃO ALOCADO",
          sheet: text(firstBlocked.sheet),
          column: text(firstBlocked.allocationStatusColumn),
          header: text(firstBlocked.allocationStatusHeader),
          row: Number(firstBlocked.row) || 0,
        },
        fiscalComment: blockedComments,
        record: firstBlocked,
        evidence: blocked.map((item) => ({
          status: "NÃO ALOCADO",
          source: item.source,
          sheet: item.sheet,
          revision: item.revision,
          row: item.row,
          item,
        })),
        ldConflict,
        hardBlock: true,
        blockCode: "not_allocated",
      });
    }
    if (ldConflict && ldConflict.blocked) {
      return reviewResult(input, {
        document: match.document,
        documentKey: match.documentKey,
        sheet: inferredSheet || (ldConflict.candidates[0] && ldConflict.candidates[0].sheet) || "",
        sheetSource: inferredSheet ? "prefixo do arquivo" : "LD",
        revision: revisionFromName(input.name || "", match.document),
        status: "Conflito na LD",
        reason: `${ldConflict.summary} O GRCON não escolheu uma linha automaticamente. Selecione a fonte correta para esta sessão antes de continuar.`,
        finalName: input.name || `${match.document}.pdf`,
        documentSource: identitySource,
        evidence: ldConflict.candidates.map((candidate) => ({
          status: "Linha em conflito",
          source: candidate.source,
          sheet: candidate.sheet,
          revision: candidate.revision,
          row: candidate.row,
          item: candidate.record,
        })),
        ldConflict,
        blockCode: "ld_conflict",
      });
    }
    if (ldConflict && ldConflict.resolved && conflictCore.applyResolution) group = conflictCore.applyResolution(group, ldConflict);
    const selection = chooseBestRecord(group, inferredSheet);
    if (selection.sheetMismatch) {
      const sheets = [...new Set(selection.candidates.map((item) => item.sheet))].join(", ");
      const allocationConflict = allocationConflictSummary(selection.candidates);
      const blocked = allocationConflict.anyNegative
        ? selection.candidates.filter((item) => allocationState(item.allocationStatus).kind === "not_allocated")
        : [];
      const blockedComments = [...new Set(blocked.map((item) => text(item.fiscalComment)).filter(Boolean))].join(" | ");
      return reviewResult(input, {
        document: match.document,
        documentKey: match.documentKey,
        sheet: inferredSheet,
        sheetSource: "prefixo do arquivo",
        revision: revisionFromName(input.name || "", match.document),
        status: "Aba incompatível",
        reason: allocationConflict.mixed
          ? `O código possui registros com situações de alocação conflitantes (Alocado e Não alocado) nas abas ${sheets}. Como existe ao menos um registro NÃO ALOCADO, a postagem permanece bloqueada.`
          : blocked.length
            ? `O prefixo indica ${inferredSheet}, mas o código foi localizado somente em ${sheets} e todos os registros de alocação reconhecidos estão como Não Alocado. A postagem permanece bloqueada.${blockedComments ? ` Comentário da Fiscal: ${blockedComments}` : ""}`
            : `O prefixo do arquivo indica a aba ${inferredSheet}, mas o código foi localizado somente em ${sheets}. Nenhuma aba foi escolhida por aproximação.`,
        finalName: input.name || `${match.document}.pdf`,
        documentSource: identitySource,
        allocationStatus: blocked.length ? "NÃO ALOCADO" : "",
        fiscalComment: blockedComments,
        hardBlock: blocked.length > 0,
        blockCode: blocked.length ? "not_allocated_conflict" : "",
      });
    }
    if (selection.ambiguous) {
      const locations = selection.candidates
        .slice(0, 5)
        .map((item) => `${item.source} / ${item.sheet} / linha ${item.row}`)
        .join("; ");
      const allocationConflict = allocationConflictSummary(selection.candidates);
      const blocked = allocationConflict.anyNegative
        ? selection.candidates.filter((item) => allocationState(item.allocationStatus).kind === "not_allocated")
        : [];
      const blockedComments = [...new Set(blocked.map((item) => text(item.fiscalComment)).filter(Boolean))].join(" | ");
      return reviewResult(input, {
        document: match.document,
        documentKey: match.documentKey,
        sheet: inferredSheet,
        sheetSource: inferredSheet ? "prefixo do arquivo" : "LD",
        revision: revisionFromName(input.name || "", match.document),
        status: "Registros conflitantes",
        reason: allocationConflict.mixed
          ? `Há registros técnicos conflitantes: pelo menos um está Alocado e outro está Não alocado. A presença de NÃO ALOCADO bloqueia a postagem. Registros: ${locations}.`
          : blocked.length
            ? `Há registros técnicos conflitantes e todos os valores de alocação reconhecidos estão como Não Alocado. A postagem permanece bloqueada.${blockedComments ? ` Comentário da Fiscal: ${blockedComments}` : ""} Registros: ${locations}.`
            : `Há mais de um registro técnico incompatível para o documento. Não foi feita escolha automática: ${locations}.`,
        finalName: input.name || `${match.document}.pdf`,
        documentSource: identitySource,
        allocationStatus: blocked.length ? "NÃO ALOCADO" : "",
        fiscalComment: blockedComments,
        hardBlock: blocked.length > 0,
        blockCode: blocked.length ? "not_allocated_conflict" : "",
      });
    }

    const technicalRecord = selection.record;
    const latestHistory = [...(group.history || [])].sort(recordCompare)[0] || null;
    if (!technicalRecord) {
      return reviewResult(input, {
        document: match.document,
        documentKey: match.documentKey,
        sheet: inferredSheet,
        sheetSource: inferredSheet ? "prefixo do arquivo" : "LD",
        revision: revisionFromName(input.name || "", match.document),
        status: "Sem linha técnica na LD",
        reason: "O código foi encontrado apenas no histórico SIGEM e não possui uma linha técnica controlada nas abas ET, N-1710 ou CV. A postagem permanece bloqueada.",
        finalName: input.name || `${match.document}.pdf`,
        documentSource: identitySource,
      });
    }

    const best = technicalRecord;
    const controlledSheet = technicalRecord.sheet;
    const document = technicalRecord.document || match.document;
    const fromFileClaim = claimedRevisionFromName(input.name || "", document);
    const fromPdf = revisionFromText(input.pdfText || "", document);
    const ldRevision = technicalRecord ? normalizeRevision(technicalRecord.revision) : "";
    const latestHistoryRev = latestHistory ? normalizeRevision(latestHistory.revision) : "";
    const controlledRevisions = [
      { value: ldRevision, source: "LD" },
      { value: latestHistoryRev, source: "histórico SIGEM" },
    ].filter((candidate) => revisionInfo(candidate.value).valid)
      .sort((a, b) => revisionRank(b.value) - revisionRank(a.value));
    let revision = controlledRevisions.length ? controlledRevisions[0].value : "";
    let revisionSource = controlledRevisions.length ? controlledRevisions[0].source : "LD";
    const claimedRevision = normalizeRevision(input.revision || fromFileClaim || fromPdf);
    let grdt = text(technicalRecord && technicalRecord.grdt);
    let effectiveDate = text(technicalRecord && technicalRecord.effectiveDate);
    const databook = text(technicalRecord && technicalRecord.databook);
    const allocationStatus = text(technicalRecord && technicalRecord.allocationStatus);
    // A alocação é lida da linha inteira: status, número de ALOC e a própria
    // existência da coluna na aba. Só o status NÃO ALOCADO bloqueia; as demais
    // situações mudam o que o GRCON afirma, não a decisão.
    const allocationDecision = allocationEvidenceState(technicalRecord);
    const allocationFinding = {
      kind: allocationDecision.kind,
      label: allocationDecision.label,
      evidence: allocationDecision.evidence,
      source: allocationDecision.source,
      tracked: allocationDecision.tracked,
      status: allocationStatus,
      allocationNumber: allocationDecision.allocationNumber || "",
      sheet: text(technicalRecord && technicalRecord.sheet),
      column: text(technicalRecord && technicalRecord.allocationStatusColumn),
      header: text(technicalRecord && technicalRecord.allocationStatusHeader),
      row: Number(technicalRecord && technicalRecord.row) || 0,
    };
    const fiscalComment = text(technicalRecord && technicalRecord.fiscalComment);
    let evidence = [];
    let analysisEvidence = null;
    let postingEvidence = technicalPostingEvidenceForRevision(group, revision, inferredSheet);
    let postingStatus = postingEvidence.status;
    let decision = REVIEW;
    let reason = "A revisão precisa de conferência manual.";
    let displayStatus = "Sem status";

    if (allocationDecision.kind === "not_allocated") {
      const codeValidation = validateDocumentCode(document, controlledSheet);
      const blockedSigem = revision
        ? statusForRevision(group, revision).status
        : text(technicalRecord && (technicalRecord.sigemStatus || technicalRecord.status)) || "Não confirmado";
      const allocationNumber = text(technicalRecord && technicalRecord.allocation);
      const allocationStage = text(technicalRecord && technicalRecord.allocationStage);
      const ldVersionSent = text(technicalRecord && technicalRecord.ldVersion);
      const allocationReasonParts = [
        "A coluna de confirmação de alocação está marcada como Não Alocado, portanto a postagem permanece bloqueada.",
      ];
      if (fiscalComment) allocationReasonParts.push(`Comentário da Fiscal: ${fiscalComment}.`);
      else allocationReasonParts.push("A linha não contém comentário da Fiscal explicando o motivo da não alocação.");
      if (allocationNumber) allocationReasonParts.push(`Alocação registrada: ${allocationNumber}.`);
      else allocationReasonParts.push("Nenhum número de alocação foi registrado nessa linha.");
      if (allocationStage && !/^(?:0|N\/A|NA|-)$/.test(norm(allocationStage))) allocationReasonParts.push(`Etapa da alocação: ${allocationStage}.`);
      if (ldVersionSent) allocationReasonParts.push(`Versão da LD enviada: ${ldVersionSent}.`);
      else if (technicalRecord && technicalRecord.ldVersionSource === "VERSÃO DA LD ENVIADA") allocationReasonParts.push("A coluna “VERSÃO DA LD ENVIADA” está vazia nessa linha.");
      else allocationReasonParts.push("A coluna “VERSÃO DA LD ENVIADA” não foi localizada na aba.");
      const allocationReason = allocationReasonParts.join(" ");
      return reviewResult(input, {
        document,
        documentKey: match.documentKey,
        sheet: controlledSheet,
        sheetSource: input.hintedSheet ? "lista informada" : inferredSheet ? "prefixo do arquivo" : "LD",
        revision,
        revisionSource,
        status: blockedSigem,
        reason: allocationReason,
        finalName: proposedFileName(input.name || `${document}.pdf`, document, revision, controlledSheet),
        grdt,
        effectiveDate,
        databook,
        record: best,
        codeValidation,
        allocationStatus,
        allocationFinding,
        fiscalComment,
        documentSource: identitySource,
        hardBlock: true,
        blockCode: "not_allocated",
      });
    }

    if (allocationDecision.kind === "unknown") {
      const codeValidation = validateDocumentCode(document, controlledSheet);
      return reviewResult(input, {
        document,
        documentKey: match.documentKey,
        sheet: controlledSheet,
        sheetSource: input.hintedSheet ? "lista informada" : inferredSheet ? "prefixo do arquivo" : "LD",
        revision,
        revisionSource,
        status: "Revisar associação da LD",
        reason: `O valor “${allocationStatus}” não foi reconhecido como Alocado nem Não alocado. O GRCON não bloqueará automaticamente. Confira a coluna ${technicalRecord.allocationStatusColumn || "—"} (${technicalRecord.allocationStatusHeader || "cabeçalho não identificado"}) na linha ${technicalRecord.row}.`,
        finalName: proposedFileName(input.name || `${document}.pdf`, document, revision, controlledSheet),
        grdt,
        effectiveDate,
        databook,
        record: best,
        codeValidation,
        allocationStatus,
        allocationFinding,
        fiscalComment,
        documentSource: identitySource,
        hardBlock: false,
        blockCode: "allocation_mapping_review",
      });
    }

    if (fromFileClaim && !revisionInfo(fromFileClaim).valid) {
      return reviewResult(input, {
        document,
        documentKey: match.documentKey,
        sheet: controlledSheet,
        sheetSource: inferredSheet ? "prefixo do arquivo" : "LD",
        revision: fromFileClaim,
        revisionSource: "nome",
        status: "Revisão inválida no nome",
        reason: `O nome do arquivo indica a revisão ${fromFileClaim}, que não atende à sequência válida.`,
        finalName: input.name || `${document}.pdf`,
        grdt,
        effectiveDate,
        databook,
        record: best,
        documentSource: identitySource,
      });
    }

    if (!revision) {
      const codeValidation = validateDocumentCode(document, controlledSheet);
      return reviewResult(input, {
        document,
        documentKey: match.documentKey,
        sheet: controlledSheet,
        sheetSource: input.hintedSheet ? "lista informada" : inferredSheet ? "prefixo do arquivo" : "LD",
        revision: "",
        revisionSource,
        status: "Revisão vazia na LD",
        reason: "A revisão está vazia. Ela não foi convertida automaticamente em 0; confirme a revisão controlada antes da postagem.",
        finalName: input.name || `${document}.pdf`,
        grdt,
        effectiveDate,
        databook,
        record: best,
        codeValidation,
        documentSource: identitySource,
      });
    }

    const revisionValidation = revisionInfo(revision);
    if (!revisionValidation.valid) {
      return reviewResult(input, {
        document,
        documentKey: match.documentKey,
        sheet: controlledSheet,
        sheetSource: input.hintedSheet ? "lista informada" : inferredSheet ? "prefixo do arquivo" : "LD",
        revision,
        revisionSource,
        status: "Revisão inválida",
        reason: "A revisão não atende à sequência válida (0, A…Z sem I/O, AA…).",
        finalName: input.name || `${document}.pdf`,
        grdt,
        effectiveDate,
        databook,
        record: best,
        documentSource: identitySource,
      });
    }

    const traversed = [];
    let completed = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const statusInfo = statusForRevision(group, revision);
      const currentStatus = text(statusInfo.status) || "Não Postado";
      const kind = statusKind(currentStatus);
      const currentRecord = recordForRevision(group, revision, inferredSheet);
      displayStatus = currentStatus;
      evidence = statusEvidence(group, revision, inferredSheet);
      postingEvidence = technicalPostingEvidenceForRevision(group, revision, inferredSheet);
      postingStatus = postingEvidence.status;

      // A situação oficial da revisão é definida exclusivamente pela Colar SIGEM.
      // Campos GRDT/Data Efetiva preenchidos nas abas técnicas permanecem como evidência
      // informativa, mas não substituem a ausência da combinação DOCUMENTO-REVISÃO.
      // Quando a combinação não existe na Colar SIGEM, a revisão é Não Postado e pode
      // seguir para uma nova eGRDT, desde que as demais validações estejam corretas.

      if (statusInfo.conflict) {
        decision = REVIEW;
        reason = `A combinação ${document}-${revision} aparece mais de uma vez na Colar SIGEM com status diferentes. Corrija a fonte controlada antes de decidir.`;
        completed = true;
        break;
      }

      if (statusInfo.incomplete) {
        decision = REVIEW;
        reason = `A combinação ${document}-${revision} existe na Colar SIGEM, mas o Status SIGEM está vazio. A ausência de status não pode ser tratada como Não Postado.`;
        completed = true;
        break;
      }

      if (kind === "not_posted") {
        decision = READY;
        if (traversed.length) {
          const sequence = traversed.map((item) => `${item.revision} (${item.status})`).join(", ");
          reason = `As revisões ${sequence} já têm retorno. A primeira combinação DOCUMENTO-REVISÃO ausente da Colar SIGEM é ${revision}, portanto está Não Postado.`;
          revisionSource = "histórico SIGEM";
        } else {
          reason = `A combinação ${document}-${revision} não existe na Colar SIGEM; o status calculado é Não Postado e pode seguir para postagem.`;
        }
        completed = true;
        break;
      }

      if (kind === "analysis") {
        // “Em Análise” somente existe quando esse texto foi realmente localizado
        // na coluna de status da aba Colar SIGEM. O status não bloqueia
        // (hardBlock continua false) e o operador pode incluir manualmente a
        // qualquer momento, mas não deve ser selecionado automaticamente como
        // se já estivesse pronto — por isso a decisão é DISCARD, não READY.
        analysisEvidence = analysisEvidenceForRevision(group, revision, inferredSheet, statusInfo);
        const analysisRecord = analysisEvidence.item;
        grdt = text(analysisRecord && analysisRecord.grdt);
        effectiveDate = text(analysisRecord && analysisRecord.effectiveDate);
        if (analysisEvidence.emissionSource) {
          evidence.push({
            status: "Fonte da GRDT e da data efetiva",
            source: analysisEvidence.emissionSource.source,
            sheet: analysisEvidence.emissionSource.sheet,
            revision,
            row: analysisEvidence.emissionSource.row,
            item: analysisRecord,
          });
        }
        const statusSheet = text(statusInfo.item && statusInfo.item.sheet) || "Colar SIGEM";
        const statusRow = Number(statusInfo.item && statusInfo.item.row) || 0;
        decision = DISCARD;
        reason = `A revisão ${revision} está explicitamente “Em Análise” na coluna de status da ${statusSheet}${statusRow ? `, linha ${statusRow}` : ""}. Esse status não bloqueia a geração da eGRDT, mas precisa de seleção manual do operador — não entra automaticamente.`;
        completed = true;
        break;
      }

      if (kind === "advance") {
        traversed.push({ revision, status: currentStatus });
        const following = nextRevision(revision);
        if (!following) {
          decision = REVIEW;
          reason = `A revisão ${revision} é de campo ou inválida para avanço automático; aplique o procedimento específico antes de gerar a próxima revisão.`;
          completed = true;
          break;
        }
        revision = following;
        revisionSource = "histórico SIGEM";
        continue;
      }

      decision = REVIEW;
      reason = `O status oficial “${currentStatus}” da revisão ${revision} não autoriza avanço automático neste fluxo. Somente Com Comentários, Sem Comentários, Aceito Sem Comentários e Recusado avançam automaticamente.`;
      completed = true;
      break;
    }

    if (!completed) {
      decision = REVIEW;
      reason = "Não foi possível localizar uma revisão Não Postado após 100 incrementos; verifique o histórico do documento.";
    }

    const recentEmission = Boolean(grdt) && isRecentDate(effectiveDate, recentDays, nowValue);
    const codeValidation = validateDocumentCode(document, controlledSheet);
    let codeValidationWarning = "";
    if (!codeValidation.valid && decision === READY) {
      // A codificação da ET é uma conferência informativa quando a própria LD
      // identifica o documento, confirma a alocação e libera a revisão para
      // postagem. Ela não rebaixa um item operacionalmente pronto.
      codeValidationWarning = `Divergência de codificação conforme a ET: ${codeValidation.errors.join(" ")}`;
      reason = `${reason} ${codeValidationWarning}`.trim();
    }
    // A situação da alocação vai escrita no motivo. Sem isso, "coluna ausente
    // na aba", "coluna vazia" e "alocado" chegavam ao operador com o mesmo
    // silêncio.
    const allocationNote = allocationFinding.kind === "not_tracked"
      ? `A alocação não foi verificada: a aba ${allocationFinding.sheet || controlledSheet} da LD não possui coluna de confirmação de alocação. Não há registro de alocação a favor nem contra este documento.`
      : allocationFinding.kind === "blank"
        ? `A alocação não foi informada: o campo “${allocationFinding.header || "confirmação de alocação"}” está vazio na linha ${allocationFinding.row || "—"} da aba ${allocationFinding.sheet || controlledSheet}.`
        : allocationFinding.evidence === "number"
          ? `Alocação evidenciada pelo número ${allocationFinding.allocationNumber}, registrado na LD sem preenchimento do campo de confirmação.`
          : "";
    if (allocationNote) reason = `${reason} ${allocationNote}`.trim();
    const finalName = proposedFileName(input.name || `${document}.pdf`, document, revision, controlledSheet);
    const egrdt = buildEgrdtData(document, revision, finalName, best, controlledSheet, input.pdfFormat);

    return enrichDecision(applyOfficialCodeRename({
      ...input,
      id: input.id,
      document,
      documentKey: match.documentKey,
      sheet: controlledSheet,
      sheetSource: input.hintedSheet ? "lista informada" : inferredSheet ? "prefixo do arquivo" : "LD",
      revision,
      revisionSource,
      status: displayStatus || "Sem status",
      decision,
      reason,
      finalName,
      grdt,
      effectiveDate,
      recentEmission,
      recentDays,
      databook,
      allocationStatus,
      allocationFinding,
      fiscalComment,
      evidence,
      analysisEvidence,
      postingEvidence,
      postingStatus,
      record: best,
      codeValidation,
      codeValidationWarning,
      egrdt,
      claimedRevision,
      documentSource: identitySource,
      ldConflict,
      ntVariant: false,
      ntRename: null,
      ldRename: null,
    }, input));
  }

  function simpleReason(row) {
    const item = row || {};
    if (Contracts) {
      const message = Contracts.enrichDecision(item).userMessage;
      return [message.title, message.explanation, message.nextAction].filter(Boolean).join(" ");
    }
    const status = norm(item.status);
    const original = text(item.reason);
    const reason = norm(original);
    const revision = text(item.revision) || "informada";
    const fiscalComment = text(item.fiscalComment);
    const fiscalSuffix = fiscalComment ? ` Comentário da Fiscal: ${fiscalComment}` : "";

    if (item.hardBlock || norm(item.allocationStatus) === "NAO ALOCADO") {
      if (item.blockCode === "not_allocated_conflict") {
        return `A LD registra ALOCADO em uma linha e NÃO ALOCADO em outra para este documento. Confirme qual vale antes de postar.${fiscalSuffix}`;
      }
      return fiscalComment
        ? `Não Alocado. Resolva o comentário da Fiscal antes de postar.${fiscalSuffix}`
        : "Não Alocado. Conclua a alocação antes de postar.";
    }

    if (item.decision === READY) {
      if (status === "EM ANALISE") {
        return `Revisão ${revision} está Em Análise na Colar SIGEM, mas está liberada para gerar a eGRDT.`;
      }
      if (status === "NAO POSTADO") {
        return reason.includes("AS REVISOES")
          ? `Revisão ${revision} liberada. É a primeira Não Postado.`
          : `Revisão ${revision} está Não Postado e pode seguir para envio.`;
      }
      return `Revisão ${revision} liberada para envio.`;
    }

    if (item.decision === DISCARD) {
      return `Revisão ${revision} já está Em Análise com GRDT recente. Desconsiderar.`;
    }

    const exactStatuses = {
      "CODIGO AMBIGUO NO NOME": "O nome informado contém mais de um código da LD. Confirme qual é o documento correto.",
      "SEM CORRESPONDENCIA NA LD": "Documento não encontrado na LD.",
      "ABA INCOMPATIVEL": "O documento foi encontrado em uma aba diferente da indicada pelo nome. Confirme a aba correta.",
      "REGISTROS CONFLITANTES": "A LD possui mais de uma linha diferente para este documento. Confirme qual linha está correta.",
      "SEM LINHA TECNICA NA LD": "Documento encontrado no histórico SIGEM, mas não encontrado nas abas técnicas da LD.",
      "REVISAO INVALIDA NO NOME": "A revisão informada no nome do arquivo é inválida. Corrija ou confirme a revisão.",
      "REVISAO VAZIA NA LD": "A revisão está vazia na LD. Preencha ou confirme antes de postar.",
      "REVISAO INVALIDA": "A revisão da LD é inválida. Confirme a sequência correta antes de postar.",
      "STATUS VAZIO NA COLAR SIGEM": `A revisão ${revision} está no SIGEM, mas o status está vazio. Preencha ou confirme o status.`,
      "CONFLITO NA COLAR SIGEM": `A revisão ${revision} possui status diferentes no SIGEM. Corrija o conflito antes de postar.`,
      "REVISOES DIVERGENTES NO PACOTE": "Os arquivos do mesmo documento indicam revisões diferentes. Confirme qual revisão está correta.",
      "PACOTE INCONSISTENTE": "Os arquivos do mesmo documento geraram resultados diferentes. Confira os arquivos selecionados.",
      "PDF NAO LOCALIZADO": "O PDF físico não foi encontrado. Inclua o arquivo antes de gerar o pacote físico.",
      "PDF NAO VALIDADO": "O PDF não pôde ser aberto e validado. Substitua ou confira o arquivo.",
      "ARQUIVO VAZIO": "O arquivo está vazio. Substitua pelo documento correto.",
      "PDF INVALIDO": "O arquivo não é um PDF válido ou não pôde ser aberto.",
    };
    if (exactStatuses[status]) return exactStatuses[status];

    if (status === "EM ANALISE") {
      if (reason.includes("NAO EXISTE UMA UNICA LINHA TECNICA")) {
        return `Revisão ${revision} está Em Análise, mas não foi encontrada uma linha correspondente na LD.`;
      }
      if (reason.includes("GRDT") && reason.includes("VAZIA")) {
        return `Revisão ${revision} está Em Análise, mas a GRDT está vazia.`;
      }
      if (reason.includes("DATA EFETIVA") && reason.includes("VAZIA")) {
        return `Revisão ${revision} está Em Análise, mas a Data Efetiva de Emissão está vazia.`;
      }
      if (reason.includes("DATA EFETIVA") && reason.includes("INVALIDA")) {
        return `Revisão ${revision} está Em Análise, mas a Data Efetiva de Emissão é inválida.`;
      }
      if (reason.includes("FORA DA JANELA")) {
        return `Revisão ${revision} está Em Análise, mas a emissão não é recente. Confirme antes de desconsiderar.`;
      }
      return `Revisão ${revision} está Em Análise. Confira a GRDT e a data de emissão.`;
    }

    if (reason.includes("STATUS OFICIAL")) {
      return `O status “${text(item.status) || "não informado"}” não possui decisão automática. Confirme antes de postar.`;
    }
    if (reason.includes("DE CAMPO") || reason.includes("INVALIDA PARA AVANCO")) {
      return `A revisão ${revision} exige conferência manual antes de avançar.`;
    }
    if (reason.includes("APOS 100 INCREMENTOS")) {
      return "O histórico possui revisões demais para uma decisão automática. Confira o documento no SIGEM.";
    }
    if (reason.includes("CODIGO DOCUMENTAL NAO PASSOU")) {
      return `O código do documento não é válido para a aba ${text(item.sheet) || "informada"}. Confirme a codificação.`;
    }
    return "Não foi possível decidir automaticamente. Confira os dados do documento na LD e no SIGEM.";
  }

  function resultCounts(results) {
    return results.reduce((acc, row) => {
      acc.total += 1;
      if (row.hardBlock) acc.bloqueado += 1;
      else acc[row.decision] += 1;
      return acc;
    }, { total: 0, pronto: 0, bloqueado: 0, descartar: 0, revisar: 0 });
  }

  return {
    READY,
    DISCARD,
    REVIEW,
    DECISION_CODES: Contracts ? Contracts.CODES : {},
    normalizeRecordContract: Contracts ? Contracts.normalizeRecord : (value) => value,
    decisionMessage: Contracts ? (row) => Contracts.enrichDecision(row).userMessage : null,
    norm,
    allocationState,
    mostRecentRecord,
    allocationNumberInfo,
    allocationEvidenceState,
    allocationConflictSummary,
    technicalPostingEvidenceForRevision,
    canonicalId,
    key,
    sheetFamily,
    sheetMatchesHint,
    isEtDocument,
    displayDocumentCode,
    ntPrefixVariant,
    documentSearchKeys,
    ntPrefixForm,
    documentLookup,
    statusKind,
    normalizeRevision,
    revisionInfo,
    revisionRank,
    nextRevision,
    compactTimestamp,
    parseDate,
    isRecentDate,
    parseWorkbook,
    buildIndex,
    exactDocumentMatch,
    matchDocument,
    matchDocuments,
    inferSheetFromName,
    inferLdVersion,
    inferLdVersionFromSourceName,
    reportGroup7Info,
    controlArtifactKind,
    revisionFromName,
    claimedRevisionFromName,
    revisionFromText,
    validateDocumentCode,
    proposedFileName,
    validateFinalFileName,
    EGRDT_OPTIONS,
    buildEgrdtData,
    isN1710Context,
    validateEgrdtData,
    triageOne,
    simpleReason,
    resultCounts,
  };
});
