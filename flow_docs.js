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
    return motor.parseDocumentList(bruto).map((linha) =>
      itemDeCodigo(linha.document, { titulo: linha.requestedTitle })
    );
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
      return lido.document && pareceCodigo(lido.document)
        ? itemDeCodigo(lido.document, { arquivo: arquivo.name })
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

  /**
   * Lê a planilha com o motor documental do GRCON e devolve os registros já no
   * formato do banco. O motor é quem sabe achar o cabeçalho em qualquer linha,
   * reconhecer as abas vigentes e mapear colunas com nomes diferentes — por
   * isso ele é reaproveitado inteiro em vez de reescrito aqui.
   */
  async function lerLd(arquivo) {
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
    const registros = (lido.records || []).concat(lido.history || []);

    const documentos = registros.map((registro) => {
      const codigo = texto(registro.document);
      const principal = chave(registro.documentKey || codigo);
      const alternativa = chaveAlternativa(codigo);
      const estado = core.allocationEvidenceState ? core.allocationEvidenceState(registro) : null;
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
        document_type: texto(registro.documentType),
        purpose: texto(registro.purpose),
        tag: texto(registro.tag),
        sheet: texto(registro.sheet),
        row_number: Number(registro.row) || 0,
        ld_version_label: texto(registro.ldVersion || lido.ldVersion),
      };
    }).filter((item) => item.document_key);

    return {
      documentos,
      ldVersion: texto(lido.ldVersion),
      abas: [...new Set(registros.map((registro) => texto(registro.sheet)).filter(Boolean))],
    };
  }

  root.FlowDocs = Object.freeze({
    chave,
    normalizar,
    chaveAlternativa,
    pareceCodigo,
    itemDeCodigo,
    itemDeTitulo,
    itemDeReferencia,
    daListaColada,
    deArquivos,
    semRepetidos,
    lerLd,
  });
})(window);
