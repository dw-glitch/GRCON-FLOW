/**
 * GRCON Flow — utilidades documentais.
 *
 * Aqui mora a ponte entre o que a pessoa digita e o que o banco consulta. A
 * normalização é a MESMA do motor documental do GRCON (TriagemCore): se cada
 * lado normalizasse à sua maneira, um documento gravado com uma grafia jamais
 * seria encontrado pela outra.
 *
 * Regra que atravessa o arquivo: nada é adivinhado. Nome de arquivo que não
 * carrega código devolve vazio, e a tela pede o código à pessoa.
 */
(function (root) {
  "use strict";

  const Core = () => root.TriagemCore;
  const Requests = () => root.GrconRequestsCore;

  function texto(valor) {
    return valor === null || valor === undefined ? "" : String(valor).trim();
  }

  /** Código normalizado, do jeito que o índice do banco guarda. */
  function chave(documento) {
    const core = Core();
    return core ? core.key(documento) : texto(documento).toUpperCase();
  }

  function normalizar(valor) {
    const core = Core();
    return core ? core.norm(valor) : texto(valor).toUpperCase();
  }

  const CATEGORIAS_N1710 = "CE|CR|DB|DE|EC|ET|FD|IM|IS|LA|LD|LI|LO|MA|MC|MD|MO|PR|PT|RL|RM|CT|SIT";
  const DISCIPLINAS_ET = "ADC|ARR|DBU|CVL|CTO|CRS|CDR|DOC|ELE|REQ|ETF|FSC|FOR|GER|HVAC|INSP|INS|PDMS|MEC|DIN|EST|PLA|PRS|PRJ|QUA|SMS|SEG|SIS|SUP|TEL|TUB";
  const PADROES_CODIGO_NORMATIVO = Object.freeze([
    new RegExp(`(?:^|[^A-Z0-9])([A-Z0-9]{3}_RNEST_[A-Z0-9]+_\\d+(?:\\.\\d+){3}_(?:${DISCIPLINAS_ET})_[A-Z0-9][A-Z0-9.-]*_[A-Z0-9][A-Z0-9.-]*)(?=$|[^A-Z0-9])`, "i"),
    /(?:^|[^A-Z0-9])(5900(?:\.\d+){3}-[A-Z0-9]{3}-CV-[A-Z0-9]+-\d{3,4})(?=$|[^A-Z0-9])/i,
    new RegExp(`(?:^|[^A-Z0-9])((?:[IAFLED]-)?(?:${CATEGORIAS_N1710})-5290\\.00-\\d{4,5}-[A-Z0-9]{3}-[A-Z0-9]{3}-\\d{3,4})(?=$|[^A-Z0-9])`, "i"),
  ]);
  const PADRAO_ET_COM_HIFENS = new RegExp(
    `(?:^|[^A-Z0-9])([A-Z0-9]{3})-RNEST-([A-Z0-9]+)-(\\d+(?:\\.\\d+){3})-(${DISCIPLINAS_ET})-([A-Z0-9]{2,10})-([A-Z0-9][A-Z0-9.-]*)(?=$|[^A-Z0-9])`,
    "i"
  );

  /**
   * Recupera somente correções determinísticas antes da triagem: caixa,
   * travessões, separadores da N-1710 e sufixos comuns de arquivo/revisão.
   * A estrutura reconhecível segue para a busca exata na LD. A decisão final
   * de aceitar pela LD, validar pela norma ou ignorar fica no servidor, que é
   * o único ponto com acesso às bases vigentes.
   */
  function corrigirCodigoParaTriagem(valor) {
    const core = Core();
    const original = texto(valor).replace(/[–—]/g, "-");
    if (!original || !core || typeof core.validateDocumentCode !== "function") return "";
    const motor = Requests();
    const semArquivo = motor && typeof motor.documentFromFileName === "function"
      ? motor.documentFromFileName(original).document : original;
    const base = core.canonicalId ? core.canonicalId(semArquivo) : normalizar(semArquivo);
    const etComHifens = base.match(PADRAO_ET_COM_HIFENS);
    const etCorrigido = etComHifens
      ? `${etComHifens[1]}_RNEST_${etComHifens[2]}_${etComHifens[3]}_${etComHifens[4]}_${etComHifens[5]}_${etComHifens[6]}`
      : "";
    const fontes = [
      etCorrigido,
      base,
      base.includes("RNEST") ? base.replace(/\s+/g, "_") : "",
      base.replace(/_/g, "-"),
    ].filter(Boolean);

    for (const fonte of fontes) {
      for (const padrao of PADROES_CODIGO_NORMATIVO) {
        const achado = fonte.match(padrao);
        if (!achado || !achado[1]) continue;
        let candidato = core.canonicalId ? core.canonicalId(achado[1]) : normalizar(achado[1]);
        const familia = candidato.includes("_RNEST_") ? "ET" : /-CV-/i.test(candidato) ? "CV" : "N-1710";
        if (familia === "ET" && typeof core.displayDocumentCode === "function") {
          candidato = core.displayDocumentCode(candidato);
        }
        const validacao = core.validateDocumentCode(candidato, familia);
        if (familia !== "N-1710" && (!validacao || !validacao.valid)) continue;
        return candidato;
      }
    }
    return "";
  }

  /**
   * A forma alternativa do código (com ou sem o prefixo `nt-`), quando o
   * documento é ET. É o que permite achar na LD um documento informado na
   * outra grafia — a mesma regra que a Triagem já usava.
   */
  function chaveAlternativa(documento) {
    const core = Core();
    if (!core || !core.documentSearchKeys) return "";
    const principal = chave(documento);
    const variantes = core.documentSearchKeys(documento) || [];
    const outra = variantes.map(chave).find((item) => item && item !== principal);
    return outra || "";
  }

  /** Um item pronto para o banco a partir de um código informado. */
  function itemDeCodigo(documento, extras = {}) {
    const codigo = texto(documento);
    return {
      document: codigo,
      document_key: codigo ? chave(codigo) : "",
      nt_key: codigo ? chaveAlternativa(codigo) : "",
      requested_title: texto(extras.titulo),
      reference: texto(extras.referencia),
      file_name: texto(extras.arquivo),
    };
  }

  /**
   * O texto informado tem cara de código documental?
   *
   * Serve só para encaminhar: um valor com cara de código vai para a busca por
   * código, o resto vai para a busca por título. Nenhum código é criado a
   * partir disso — o que a pessoa escreveu é usado como ela escreveu.
   */
  function pareceCodigo(valor) {
    const bruto = texto(valor);
    if (!bruto || /\s/.test(bruto)) return false;      // código não tem espaço
    if (!/\d/.test(bruto)) return false;                // e sempre tem dígito
    if (!/[-_./]/.test(bruto)) return false;            // e sempre tem separador
    if (chave(bruto).length < 7) return false;          // curto demais para ser código
    return /^[A-Za-z0-9][A-Za-z0-9._\-/]+$/.test(bruto);
  }

  /**
   * Uma referência solta — o que o solicitante tinha em mãos. Vira item com
   * código quando parece código, e item com título quando não parece.
   */
  function itemDeReferencia(valor) {
    const bruto = texto(valor);
    if (!bruto) return itemDeTitulo("", "");
    return pareceCodigo(bruto)
      ? itemDeCodigo(bruto, { referencia: bruto })
      : itemDeTitulo(bruto, bruto);
  }

  /** Item sem código: só título, pergunta ou referência solta. */
  function itemDeTitulo(titulo, referencia) {
    return {
      document: "",
      document_key: "",
      nt_key: "",
      requested_title: texto(titulo),
      reference: texto(referencia),
      file_name: "",
    };
  }

  /**
   * Lista colada. Aceita um por linha, e também o par código + título separado
   * por tabulação, que é como sai de uma planilha.
   */
  function daListaColada(bruto) {
    const motor = Requests();
    if (!motor) return [];
    return motor.parseDocumentList(bruto).map((linha) => {
      const codigo = corrigirCodigoParaTriagem(linha.document);
      if (codigo) return itemDeCodigo(codigo, { titulo: linha.requestedTitle });
      return linha.requestedTitle ? itemDeTitulo(linha.requestedTitle, linha.document) : null;
    }).filter(Boolean);
  }

  /**
   * Lista flexível para Postagem no SIGEM. Cada linha pode ser:
   *   - apenas o título;
   *   - apenas o código;
   *   - código + título separados por TAB, ponto-e-vírgula ou |.
   * O código continua opcional: título sem código vira item legítimo para a
   * equipe identificar antes de incluir na LD, alocar e postar.
   */
  function daListaFlexivel(bruto) {
    return texto(bruto).split(/\r?\n/).map((linha) => linha.trim()).filter(Boolean).map((linha) => {
      const partes = linha.split(/\t|\s*[;|]\s*/).map((item) => texto(item)).filter(Boolean);
      if (partes.length > 1 && pareceCodigo(partes[0])) {
        const codigo = corrigirCodigoParaTriagem(partes[0]);
        const titulo = partes.slice(1).join(" - ");
        return codigo ? itemDeCodigo(codigo, { titulo }) : (titulo ? itemDeTitulo(titulo, partes[0]) : null);
      }
      if (pareceCodigo(linha)) {
        const codigo = corrigirCodigoParaTriagem(linha);
        return codigo ? itemDeCodigo(codigo) : null;
      }
      return itemDeTitulo(linha, "");
    }).filter(Boolean);
  }

  /**
   * Arquivos arrastados. O código sai do nome, sem extensão e sem o sufixo de
   * postagem do SIGEM.
   *
   * O motor devolve o nome do arquivo sem extensão mesmo quando ele não é um
   * código — "digitalizar0001.pdf" viraria o "documento" `digitalizar0001`, que
   * nenhuma LD teria. Por isso o resultado ainda passa por `pareceCodigo`:
   * arquivo cujo nome não é código vira item SEM código, registrado do mesmo
   * jeito e com o nome do arquivo guardado como referência.
   */
  function deArquivos(arquivos) {
    const motor = Requests();
    if (!motor) return [];
    const lista = Array.from(arquivos || []);
    return lista.map((arquivo) => {
      const lido = motor.documentFromFileName(arquivo.name);
      const codigo = corrigirCodigoParaTriagem(lido.document);
      return codigo
        ? itemDeCodigo(codigo, { arquivo: arquivo.name })
        : { ...itemDeTitulo("", arquivo.name), file_name: arquivo.name };
    });
  }

  /** Remove repetições pelo código normalizado, preservando o título já dado. */
  function semRepetidos(itens) {
    const vistos = new Map();
    const mantidos = [];
    const removidos = [];
    (itens || []).forEach((item) => {
      // Item sem código nunca é considerado repetido: dois pedidos podem citar
      // títulos parecidos e continuarem sendo coisas diferentes.
      if (!item.document_key) { mantidos.push(item); return; }
      if (vistos.has(item.document_key)) {
        const anterior = vistos.get(item.document_key);
        if (!anterior.requested_title && item.requested_title) {
          anterior.requested_title = item.requested_title;
        }
        removidos.push(item);
        return;
      }
      const copia = { ...item };
      vistos.set(item.document_key, copia);
      mantidos.push(copia);
    });
    return { itens: mantidos, removidos };
  }

  // ---------------------------------------------------------------------------
  // Leitura de uma LD para a Base Documental
  // ---------------------------------------------------------------------------

  async function hashDoBuffer(buffer) {
    const crypto = root.crypto;
    if (!crypto || !crypto.subtle || !crypto.subtle.digest) return "";
    const digest = await crypto.subtle.digest("SHA-256", buffer.slice(0));
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function metadadosDasAbas(workbook, lido) {
    const porNome = new Map();
    const metadata = workbook.Workbook && workbook.Workbook.Sheets || [];
    const obter = (nome) => {
      if (!porNome.has(nome)) {
        const info = metadata.find((item) => texto(item && item.name) === nome);
        porNome.set(nome, {
          nome,
          papel: "tecnica",
          oculta: Boolean(Number(info && info.Hidden)),
          registros: 0,
        });
      }
      return porNome.get(nome);
    };
    (lido.records || []).forEach((registro) => {
      const aba = obter(texto(registro.sheet) || "(sem nome)");
      aba.registros += 1;
      aba.oculta = aba.oculta || Boolean(Number(registro.sheetHidden));
    });
    (lido.history || []).forEach((registro) => {
      const aba = obter(texto(registro.sheet) || "Colar SIGEM");
      aba.papel = "historico";
      aba.registros += 1;
      aba.oculta = aba.oculta || Boolean(Number(registro.sheetHidden));
    });
    return [...porNome.values()].map((aba) => ({
      ...aba,
      selecionadaPorPadrao: aba.papel === "tecnica" && !aba.oculta,
    }));
  }

  /**
   * Lê uma vez o arquivo e guarda as duas fontes separadas. A aba histórica
   * `Colar SIGEM` continua disponível como evidência, mas jamais entra no
   * índice vigente das LDs.
   */
  async function lerFonteLd(arquivo) {
    const XLSX = root.XLSX;
    const core = Core();
    if (!XLSX || !core) throw new Error("Motor documental indisponível. Recarregue a página.");

    const buffer = await arquivo.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array", cellDates: false, cellStyles: false });

    // Célula mesclada guarda o valor só no canto superior esquerdo; sem
    // replicar, as demais linhas do intervalo chegariam vazias.
    if (core.expandMergedCells) {
      (workbook.SheetNames || []).forEach((nome) => {
        try { core.expandMergedCells(workbook.Sheets[nome]); } catch (_) { /* aba sem mescla */ }
      });
    }

    const lido = core.parseWorkbook(workbook, arquivo.name, arquivo.lastModified || Date.now(), null);
    return {
      nome: texto(arquivo.name),
      tamanho: Number(arquivo.size) || buffer.byteLength || 0,
      modificadoEm: Number(arquivo.lastModified) || 0,
      hash: await hashDoBuffer(buffer),
      ldVersion: texto(lido.ldVersion),
      registrosTecnicos: lido.records || [],
      registrosHistoricos: lido.history || [],
      abas: metadadosDasAbas(workbook, lido),
    };
  }

  function familiaDoRegistro(registro) {
    const codigo = texto(registro && registro.document);
    const aba = normalizar(registro && registro.sheet);
    if (/^[A-Z0-9]{2,10}-RNC-\d{5}\/\d{4}$/i.test(codigo)) return "INTERNO";
    if (aba === "ET" || /_RNEST_/i.test(codigo)) return "ET";
    if (aba === "CV") return "CV";
    return "N-1710";
  }

  function tipoDoRegistro(registro, familia) {
    const informado = texto(registro && registro.documentType);
    if (informado) return informado;
    const codigo = texto(registro && registro.document);
    if (familia === "ET") return texto(codigo.split("_")[5]);
    if (familia === "N-1710") {
      const grupos = codigo.split("-");
      return /^[IAFLED]$/i.test(grupos[0] || "") ? texto(grupos[1]) : texto(grupos[0]);
    }
    if (familia === "CV") return "CV";
    if (familia === "INTERNO") return "RNC";
    return "";
  }

  function tagDoRegistro(registro, familia) {
    const informado = texto(registro && registro.tag);
    if (informado) return informado;
    const core = Core();
    if (familia !== "ET" || !core || !core.reportGroup7Info) return "";
    return texto(core.reportGroup7Info(registro.document).tag);
  }

  function conjuntoRegra(regras, chave, padrao) {
    const valor = regras && regras[chave];
    return new Set((Array.isArray(valor) ? valor : padrao || []).map(normalizar));
  }

  function validarRegistro(registro, regras) {
    const core = Core();
    const familia = familiaDoRegistro(registro);
    if (familia === "INTERNO") return { familia, valido: true, mensagens: [] };

    const base = core && core.validateDocumentCode
      ? core.validateDocumentCode(registro.document, registro.sheet)
      : { valid: true, errors: [] };
    const mensagens = [...(base.errors || [])];

    if (familia === "ET") {
      const grupos = texto(registro.document).split("_");
      const emissores = conjuntoRegra(regras, "emissores", ["C1O"]);
      const unidades = conjuntoRegra(regras, "unidades", ["U32"]);
      const tipos = conjuntoRegra(regras, "tipos_relatorio", []);
      if (grupos[0] && emissores.size && !emissores.has(normalizar(grupos[0]))) {
        mensagens.push("Grupo 1 (emissor) não consta na regra vigente.");
      }
      if (grupos[2] && unidades.size && !unidades.has(normalizar(grupos[2]))) {
        mensagens.push("Grupo 3 (unidade) não consta na regra vigente.");
      }
      if (grupos[5] && tipos.size && !tipos.has(normalizar(grupos[5]))) {
        mensagens.push("Grupo 6 (tipo de relatório) não consta no catálogo da ET vigente.");
      }
    }
    return { familia, valido: mensagens.length === 0, mensagens: [...new Set(mensagens)] };
  }

  function assinatura(registro) {
    const core = Core();
    const estado = core && core.allocationEvidenceState ? core.allocationEvidenceState(registro) : null;
    return JSON.stringify([
      normalizar(registro.title), normalizar(registro.revision), normalizar(registro.allocation),
      normalizar(registro.allocationStatus), texto(estado && estado.kind),
      normalizar(registro.grdt), normalizar(registro.sigemStatus), normalizar(registro.discipline),
      normalizar(registro.documentType), normalizar(registro.purpose), normalizar(registro.tag),
    ]);
  }

  function escolherMaisRecente(registros) {
    const core = Core();
    const ordenados = (registros || []).slice().sort((a, b) => (
      Number(Boolean(b.sheetHidden)) - Number(Boolean(a.sheetHidden))
      || (Number(b.sourceOrder) || 0) - (Number(a.sourceOrder) || 0)
      || (Number(b.row) || 0) - (Number(a.row) || 0)
    ));
    return core && core.mostRecentRecord
      ? core.mostRecentRecord(ordenados.filter((item) => !item.sheetHidden).length
        ? ordenados.filter((item) => !item.sheetHidden) : ordenados)
      : ordenados[0];
  }

  function mapearDocumento(registro, regras) {
    const core = Core();
    const codigo = texto(registro.document);
    const principal = chave(registro.documentKey || codigo);
    const alternativa = chaveAlternativa(codigo);
    const estado = core && core.allocationEvidenceState ? core.allocationEvidenceState(registro) : null;
    const validacao = validarRegistro(registro, regras);
    const tipo = tipoDoRegistro(registro, validacao.familia);
    return {
      document: codigo,
      document_key: principal,
      nt_key: alternativa && alternativa !== principal ? alternativa : "",
      title: texto(registro.title),
      title_norm: normalizar(registro.title),
      revision: texto(registro.revision),
      allocation: texto(registro.allocation),
      allocation_status: texto(registro.allocationStatus),
      allocation_kind: texto(estado && estado.kind),
      grdt: texto(registro.grdt),
      sigem_status: texto(registro.sigemStatus),
      discipline: texto(registro.discipline),
      document_type: tipo,
      purpose: texto(registro.purpose),
      tag: tagDoRegistro(registro, validacao.familia),
      sheet: texto(registro.sheet),
      row_number: Number(registro.row) || 0,
      ld_version_label: texto(registro.ldVersion),
      raw: {
        source_kind: "technical",
        source_file: texto(registro.source),
        sheet_hidden: Boolean(Number(registro.sheetHidden)),
        effective_date: texto(registro.effectiveDate),
        status: texto(registro.status),
        format: texto(registro.format),
        databook: texto(registro.databook),
        code_family: validacao.familia,
        validation_status: validacao.valido ? "valido" : "alerta",
        validation_messages: validacao.mensagens,
      },
    };
  }

  /**
   * Constrói a prévia publicável. Duplicatas idênticas são consolidadas;
   * conflitos permanecem bloqueados até o administrador assumir, de forma
   * explícita, a regra determinística da linha técnica mais recente.
   */
  function analisarFonteLd(fonte, opcoes = {}) {
    const selecionadas = new Set(
      Array.isArray(opcoes.abasIncluidas)
        ? opcoes.abasIncluidas.map(texto)
        : (fonte.abas || []).filter((aba) => aba.selecionadaPorPadrao).map((aba) => aba.nome)
    );
    const registros = (fonte.registrosTecnicos || []).filter((registro) => selecionadas.has(texto(registro.sheet)));
    const grupos = new Map();
    registros.forEach((registro) => {
      const key = chave(registro.documentKey || registro.document);
      if (!key) return;
      if (!grupos.has(key)) grupos.set(key, []);
      grupos.get(key).push(registro);
    });

    const documentos = [];
    const conflitos = [];
    const alertasCodigo = [];
    let duplicadosIdenticos = 0;
    grupos.forEach((ocorrencias, documentKey) => {
      const variantes = new Map();
      ocorrencias.forEach((registro) => {
        const sig = assinatura(registro);
        if (!variantes.has(sig)) variantes.set(sig, []);
        variantes.get(sig).push(registro);
      });
      duplicadosIdenticos += ocorrencias.length - variantes.size;
      if (variantes.size > 1) {
        const conflito = {
          document_key: documentKey,
          document: texto(ocorrencias[0].document),
          ocorrencias: ocorrencias.map((item) => ({
            sheet: texto(item.sheet), row_number: Number(item.row) || 0,
            revision: texto(item.revision), title: texto(item.title),
            allocation: texto(item.allocation), allocation_status: texto(item.allocationStatus),
            grdt: texto(item.grdt), sigem_status: texto(item.sigemStatus),
          })),
        };
        conflitos.push(conflito);
        if (opcoes.resolverConflitos !== "linha_mais_recente") return;
      }
      const escolhido = escolherMaisRecente(ocorrencias);
      const documento = mapearDocumento(escolhido, opcoes.regras || {});
      if (documento.raw.validation_status === "alerta") {
        alertasCodigo.push({
          document: documento.document, sheet: documento.sheet, row_number: documento.row_number,
          messages: documento.raw.validation_messages,
        });
      }
      documentos.push(documento);
    });

    const erros = [];
    if (!selecionadas.size || !registros.length) erros.push("Selecione ao menos uma aba técnica com documentos.");
    if (conflitos.length && opcoes.resolverConflitos !== "linha_mais_recente") {
      erros.push(`${conflitos.length.toLocaleString("pt-BR")} código(s) possuem linhas técnicas divergentes.`);
    }

    const abas = (fonte.abas || []).map((aba) => ({ ...aba, selecionada: selecionadas.has(aba.nome) }));
    return {
      documentos,
      ldVersion: texto(fonte.ldVersion),
      hash: texto(fonte.hash),
      abas,
      conflitos,
      alertasCodigo,
      erros,
      podePublicar: erros.length === 0,
      relatorio: {
        schema_version: 1,
        source_hash: texto(fonte.hash),
        technical_rows_read: registros.length,
        history_rows_excluded: (fonte.registrosHistoricos || []).length,
        unique_documents: documentos.length,
        identical_duplicates_removed: duplicadosIdenticos,
        conflicting_documents: conflitos.length,
        conflict_resolution: opcoes.resolverConflitos || "bloquear",
        code_warnings: alertasCodigo.length,
        included_sheets: abas.filter((aba) => aba.selecionada).map((aba) => aba.nome),
        excluded_history_sheets: abas.filter((aba) => aba.papel === "historico").map((aba) => aba.nome),
        conflict_sample: conflitos.slice(0, 50),
        warning_sample: alertasCodigo.slice(0, 100),
      },
    };
  }

  /** Compatibilidade com integrações antigas: usa apenas abas técnicas visíveis. */
  async function lerLd(arquivo, opcoes = {}) {
    const fonte = await lerFonteLd(arquivo);
    return analisarFonteLd(fonte, opcoes);
  }

  root.FlowDocs = Object.freeze({
    chave,
    normalizar,
    chaveAlternativa,
    corrigirCodigoParaTriagem,
    pareceCodigo,
    itemDeCodigo,
    itemDeTitulo,
    itemDeReferencia,
    daListaColada,
    daListaFlexivel,
    deArquivos,
    semRepetidos,
    lerFonteLd,
    analisarFonteLd,
    lerLd,
  });
})(window);
