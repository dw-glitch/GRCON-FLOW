/**
 * GRCON — Módulo de Solicitações
 *
 * Aba própria, separada da consulta de documentos. Aqui se registra o pedido
 * que chegou, monta-se a lista de documentos, gera-se a planilha no padrão do
 * Controle de Solicitações e acompanha-se o que já está gravado.
 *
 * Três coisas que este módulo faz e que antes davam trabalho manual:
 *
 *   1. O código do documento sai do nome do arquivo anexado. Ninguém precisa
 *      copiar e colar nome de arquivo um a um.
 *   2. A LD é opcional e, quando anexada, responde o número da alocação e se o
 *      documento está alocado — usando o mesmo motor da Triagem.
 *   3. A saída é a planilha oficial: mesma ordem, mesmos nomes de coluna,
 *      cabeçalho na linha 5 e dados a partir da 6, para colar sem rearrumar.
 *
 * As duas regras do módulo continuam valendo: nunca inventar (sem LD, campo em
 * branco; documento não localizado é dito assim) e nunca casar por semelhança
 * (o código é comparado pelo motor documental, não por parecença).
 */
(function (root) {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const R = () => root.GrconRequestsCore;
  const C = () => root.TriagemCore;
  const Report = () => root.GrconRequestsReport;

  const els = {};
  const state = {
    lds: [],          // { id, file, name, records, history, error }
    index: null,
    entries: [],      // { document, requestedTitle, fileName, source }
    rows: [],         // linhas do Controle de Solicitações, já editáveis
    undo: [],         // pilha para desfazer alterações em lote
    tipos: [],
    painelItems: [],
    painelQuick: "todos",
    painelSearch: "",
    painelStatus: "",
    painelOwner: "",
    painelSelected: new Set(),
    consultando: false,
  };

  const text = (valor) => (valor === null || valor === undefined ? "" : String(valor).trim());

  function notify(mensagem, tipo) {
    if (root.GrconNotify) root.GrconNotify(mensagem, tipo || "info");
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ---------------------------------------------------------------------------
  // Cabeçalho e linhas
  // ---------------------------------------------------------------------------
  function cabecalho() {
    const data = els.received && els.received.value;
    return {
      owner: text(els.owner && els.owner.value),
      receivedAt: data ? data.split("-").reverse().join("/") : "",
      requester: text(els.requester && els.requester.value),
      requestType: els.type ? els.type.value : "",
      origin: els.origin ? els.origin.value : "",
      documentPath: text(els.path && els.path.value),
      documentFamily: text(els.family && els.family.value),
      emailBody: text(els.email && els.email.value),
      overallStatus: text(els.status && els.status.value),
    };
  }

  /**
   * Numera os itens continuando a sequência da planilha oficial: lá o ITEM é
   * único e contínuo, e reiniciar por solicitação criaria dois itens 561.
   */
  function linhasDoCabecalho() {
    const proximo = Math.max(1, Math.trunc(Number(els.nextItem && els.nextItem.value)) || 1);
    const base = proximo > 1 ? [{ protocol: String(proximo - 1) }] : [];
    return R().buildManualControlRows(state.entries, cabecalho(), base);
  }

  /**
   * Reconstrói as linhas preservando o que já foi editado à mão. Recriar do zero
   * apagaria o trabalho de quem preencheu metade da tabela.
   */
  function regerar() {
    const editadas = new Map(state.rows.map((linha) => [linha.item, linha]));
    state.rows = linhasDoCabecalho().map((linha) => {
      const anterior = editadas.get(linha.item);
      return anterior ? { ...anterior, document: linha.document } : { ...linha, _selected: true };
    });
    render();
  }

  function acrescentar(entradas) {
    if (!entradas.length) return 0;
    const existentes = new Set(state.entries.map((item) => (C() ? C().key(item.document) : text(item.document).toUpperCase())));
    let novos = 0;
    entradas.forEach((entrada) => {
      const chave = C() ? C().key(entrada.document) : text(entrada.document).toUpperCase();
      // Item em branco entra sempre: é o pedido ainda sem código definido.
      if (chave && existentes.has(chave)) return;
      if (chave) existentes.add(chave);
      state.entries.push(entrada);
      novos += 1;
    });
    regerar();
    return novos;
  }

  // ---------------------------------------------------------------------------
  // Arquivos anexados
  //
  // O nome do arquivo já traz o código do documento. Extrair daqui evita a
  // digitação e, principalmente, o erro de digitação — que na planilha vira um
  // item que ninguém encontra depois.
  // ---------------------------------------------------------------------------
  function anexarArquivos(fileList) {
    const arquivos = [...(fileList || [])];
    if (!arquivos.length) return;
    const entradas = R().documentsFromFiles(arquivos);
    const ignorados = arquivos.length - entradas.length;
    const novos = acrescentar(entradas);
    const repetidos = entradas.length - novos;
    const partes = [`${novos} item(ns) a partir do nome dos arquivos.`];
    if (repetidos) partes.push(`${repetidos} já estavam na lista.`);
    if (ignorados) partes.push(`${ignorados} arquivo(s) sem código reconhecível no nome.`);
    notify(partes.join(" "), novos ? "success" : "warn");
  }

  function renderArquivos() {
    if (!els.fileList) return;
    const comArquivo = state.entries.filter((item) => item.fileName);
    els.fileList.innerHTML = comArquivo.map((item, indice) => `<div class="requests-ld-item">
      <svg aria-hidden="true" viewbox="0 0 24 24"><path d="M6 2h8l4 4v16H6z"></path><path d="M14 2v4h4"></path></svg>
      <span class="requests-ld-name">${escapeHtml(item.fileName)}</span>
      <span class="requests-ld-ok">${escapeHtml(item.document)}</span>
      <button class="requests-ld-remove" data-remove-file="${indice}" title="Remover este item" type="button" aria-label="Remover ${escapeHtml(item.fileName)}">&times;</button>
    </div>`).join("");
  }

  function colar(texto) {
    // Cada linha pode ser um código ou um nome de arquivo: quem cola de uma
    // pasta não deveria ter de limpar extensão e sufixo antes.
    const linhas = String(texto || "").split(/\r?\n/).map((linha) => linha.trim()).filter(Boolean);
    if (!linhas.length) { notify("Informe ao menos um documento.", "warn"); return; }
    const entradas = [];
    linhas.forEach((linha) => {
      const [bruto, ...resto] = linha.split("\t");
      const lido = R().documentFromFileName(bruto);
      const documento = lido.document || text(bruto);
      if (!documento) return;
      entradas.push({
        document: documento,
        requestedTitle: resto.join(" ").trim(),
        fileName: lido.changed ? lido.fileName : "",
        source: lido.changed ? "nome de arquivo colado" : "código colado",
      });
    });
    const novos = acrescentar(entradas);
    els.paste.value = "";
    notify(novos ? `${novos} item(ns) acrescentados.` : "Todos os itens colados já estavam na lista.", novos ? "success" : "info");
  }

  // ---------------------------------------------------------------------------
  // LD opcional
  // ---------------------------------------------------------------------------
  async function lerLd(file) {
    await root.GRCONModuleLoader.ensure("xlsx");
    const buffer = root.GrconFileAccess
      ? await root.GrconFileAccess.read(file, { context: "a LD controlada", retries: 1 })
      : await file.arrayBuffer();
    const workbook = root.XLSX.read(buffer, { type: "array", cellDates: true, cellStyles: false });
    return C().parseWorkbook(workbook, file.name, file.lastModified);
  }

  async function anexarLds(fileList) {
    const arquivos = [...(fileList || [])].filter((file) => /\.(xlsx?|xlsm)$/i.test(file.name));
    if (!arquivos.length) return;
    for (const file of arquivos) {
      if (state.lds.some((item) => item.name === file.name && item.size === file.size)) continue;
      const entrada = { id: `ld-${state.lds.length + 1}-${Date.now()}`, file, name: file.name, size: file.size, records: [], history: [], error: "" };
      state.lds.push(entrada);
      renderLds();
      try {
        const parsed = await lerLd(file);
        entrada.records = parsed.records || [];
        entrada.history = parsed.history || [];
        if (!entrada.records.length) entrada.error = "Nenhuma linha de documento foi reconhecida nesta planilha.";
      } catch (erro) {
        // Um arquivo inválido não pode derrubar os demais.
        entrada.error = (erro && erro.message) || "Não foi possível ler este arquivo.";
      }
      reconstruirIndice();
      renderLds();
    }
    render();
  }

  function reconstruirIndice() {
    const validas = state.lds.filter((item) => !item.error && item.records.length);
    state.index = validas.length
      ? C().buildIndex(validas.flatMap((item) => item.records), validas.flatMap((item) => item.history || []))
      : null;
  }

  function renderLds() {
    if (!els.ldList) return;
    els.ldList.innerHTML = state.lds.map((item) => {
      const estado = item.error
        ? `<span class="requests-ld-error">${escapeHtml(item.error)}</span>`
        : item.records.length
          ? `<span class="requests-ld-ok">${item.records.length.toLocaleString("pt-BR")} linha(s) de documento</span>`
          : '<span class="requests-ld-loading">Lendo…</span>';
      return `<div class="requests-ld-item${item.error ? " has-error" : ""}">
        <svg aria-hidden="true" viewbox="0 0 24 24"><path d="M6 2h8l4 4v16H6z"></path><path d="M14 2v4h4"></path></svg>
        <span class="requests-ld-name">${escapeHtml(item.name)}</span>
        ${estado}
        <button class="requests-ld-remove" data-remove-ld="${escapeHtml(item.id)}" title="Remover esta LD" type="button" aria-label="Remover ${escapeHtml(item.name)}">&times;</button>
      </div>`;
    }).join("");
    if (els.ldClear) els.ldClear.hidden = !state.lds.length;
    if (els.ldRun) els.ldRun.disabled = !state.index || !state.rows.length || state.consultando;
  }

  /**
   * Consulta cada item na LD e traz o número da alocação e a situação. O que a
   * pessoa já digitou não é sobrescrito; o que a LD não responde fica em branco.
   */
  function consultarNaLd() {
    if (!state.index) { notify("Anexe ao menos uma LD legível para consultar.", "warn"); return; }
    if (!state.rows.length) { notify("Acrescente os documentos antes de consultar.", "warn"); return; }
    state.consultando = true;
    renderLds();
    let localizados = 0;
    state.rows = state.rows.map((linha) => {
      if (!text(linha.document)) return linha;
      const fatos = R().ldFactsFor(linha.document, state.index, {});
      if (fatos.found) localizados += 1;
      return R().applyLdFacts(linha, fatos);
    });
    state.consultando = false;
    render();
    const ausentes = state.rows.filter((linha) => linha._ldConsulted && !linha._ldFound).length;
    notify(`${localizados} documento(s) localizados na LD. ${ausentes ? `${ausentes} não localizado(s): marcados como inclusão na LD necessária.` : ""}`.trim(), "success");
  }

  // ---------------------------------------------------------------------------
  // Tabela dos itens
  // ---------------------------------------------------------------------------
  function render() {
    renderArquivos();
    renderLds();
    atualizarPassos();
    if (!els.preview) return;
    const linhas = state.rows;
    if (!linhas.length) {
      els.preview.innerHTML = '<p class="requests-vazio">Nenhum item ainda. Anexe os arquivos do pedido ou cole os códigos acima.</p>';
      els.batchBar.hidden = true;
      els.tableWrap.hidden = true;
      atualizarContagem();
      return;
    }
    const consultados = linhas.filter((linha) => linha._ldConsulted).length;
    const alocados = linhas.filter((linha) => linha._allocationKind === "allocated").length;
    const novos = linhas.filter((linha) => linha.needsLdInclusion === "sim").length;
    els.preview.innerHTML = `<p><strong>${linhas.length}</strong> item(ns), do <strong>${linhas[0].item}</strong> ao <strong>${linhas[linhas.length - 1].item}</strong>.
      ${consultados ? `${consultados} consultados na LD · ${alocados} alocado(s). ` : ""}${novos ? `${novos} precisam de inclusão na LD. ` : ""}
      O que estiver na tabela é o que vai para a planilha.</p>`;

    if (els.full && els.full.checked) renderTabelaCompleta(linhas);
    else renderTabelaResumida(linhas);

    const tipos = tiposAtivos();
    if (els.batchType && els.batchType.options.length <= 1) {
      tipos.forEach((rotulo) => {
        const opcao = document.createElement("option");
        opcao.value = rotulo; opcao.textContent = rotulo;
        els.batchType.appendChild(opcao);
      });
    }
    els.batchBar.hidden = false;
    els.tableWrap.hidden = false;
    atualizarContagem();
  }

  function tiposAtivos() {
    const lista = state.tipos.length ? state.tipos : R().requestTypeList(null);
    return lista.filter((tipo) => tipo.active).map((tipo) => tipo.label);
  }

  function cabecalhoSelecao(linhas) {
    const todas = linhas.length > 0 && linhas.every((linha) => linha._selected !== false);
    return `<th class="requests-col-check"><input aria-label="Selecionar todos os itens" id="sol-select-all" type="checkbox"${todas ? " checked" : ""}/></th>`;
  }

  function renderTabelaResumida(linhas) {
    els.thead.innerHTML = `<tr>${cabecalhoSelecao(linhas)}${["ITEM", "Documento", "Descrição da Solicitação",
      "Responsável", "Inclusão na LD?", "Alocação", "Alocado?", "Status SIGEM", "Observações"]
      .map((titulo) => `<th>${titulo}</th>`).join("")}</tr>`;
    const tipos = tiposAtivos();
    els.tbody.innerHTML = linhas.map((linha, indice) => {
      const opcoes = tipos.map((rotulo) => `<option${rotulo === linha.requestType ? " selected" : ""}>${escapeHtml(rotulo)}</option>`).join("");
      const inclusao = ["", "sim", "não", "na"].map((valor) =>
        `<option value="${valor}"${valor === linha.needsLdInclusion ? " selected" : ""}>${valor || "—"}</option>`).join("");
      const alocado = text(linha._allocated)
        || (linha._ldConsulted ? "Não localizado na LD" : "Sem LD consultada");
      return `<tr${linha._needsManualValidation ? ' class="precisa-validar"' : ""}>
        <td class="requests-col-check"><input aria-label="Selecionar item ${escapeHtml(linha.item)}" data-sol-select="${indice}" type="checkbox"${linha._selected === false ? "" : " checked"}/></td>
        <td><strong>${escapeHtml(linha.item)}</strong></td>
        <td><input class="sol-document-input" data-sol-field="document" data-sol-row="${indice}" type="text" value="${escapeHtml(linha.document)}"/>${linha._fileName ? `<small class="requests-count">${escapeHtml(linha._fileName)}</small>` : ""}</td>
        <td><select data-sol-field="requestType" data-sol-row="${indice}">${opcoes}</select></td>
        <td><input data-sol-field="owner" data-sol-row="${indice}" type="text" value="${escapeHtml(linha.owner)}"/></td>
        <td><select data-sol-field="needsLdInclusion" data-sol-row="${indice}">${inclusao}</select></td>
        <td><input data-sol-field="allocation" data-sol-row="${indice}" type="text" value="${escapeHtml(linha.allocation)}"/></td>
        <td>${escapeHtml(alocado)}</td>
        <td><input data-sol-field="sigemStatus" data-sol-row="${indice}" type="text" value="${escapeHtml(linha.sigemStatus)}"/></td>
        <td><input data-sol-field="observations" data-sol-row="${indice}" type="text" value="${escapeHtml(linha.observations)}"/></td>
      </tr>`;
    }).join("");
  }

  /**
   * As 26 colunas da planilha, na ordem dela e todas editáveis. ITEM continua
   * sendo mostrado e não digitado: a numeração vem do campo "Próximo item".
   */
  function renderTabelaCompleta(linhas) {
    const colunas = Report().CONTROL_COLUMNS;
    els.thead.innerHTML = `<tr>${cabecalhoSelecao(linhas)}${colunas
      .map((coluna) => `<th>${escapeHtml(coluna.header)}</th>`).join("")}</tr>`;
    els.tbody.innerHTML = linhas.map((linha, indice) => `<tr${linha._needsManualValidation ? ' class="precisa-validar"' : ""}>
      <td class="requests-col-check"><input aria-label="Selecionar item ${escapeHtml(linha.item)}" data-sol-select="${indice}" type="checkbox"${linha._selected === false ? "" : " checked"}/></td>
      ${colunas.map((coluna) => (coluna.key === "item"
        ? `<td><strong>${escapeHtml(linha.item)}</strong></td>`
        : `<td><input data-sol-field="${coluna.key}" data-sol-row="${indice}" type="text" value="${escapeHtml(linha[coluna.key] || "")}"/></td>`)).join("")}
    </tr>`).join("");
  }

  function atualizarContagem() {
    const quantos = state.rows.filter((linha) => linha._selected !== false).length;
    if (els.batchCount) els.batchCount.textContent = `${quantos} selecionado(s)`;
    if (els.batchUndo) els.batchUndo.disabled = !state.undo.length;
    if (els.docCount) els.docCount.textContent = `${state.rows.length} item(ns) na solicitação`;
    const temItens = state.rows.length > 0;
    [els.excel, els.copy, els.copyHeaders, els.save].forEach((botao) => { if (botao) botao.disabled = !temItens; });
  }

  function atualizarPassos() {
    const marcar = (elemento, pronto, atual) => {
      if (!elemento) return;
      elemento.classList.toggle("is-done", pronto);
      elemento.classList.toggle("is-current", atual);
    };
    const temCabecalho = Boolean(text(els.number && els.number.value) || text(els.requester && els.requester.value));
    const temItens = state.rows.length > 0;
    const temLd = Boolean(state.index);
    marcar(els.step1, temCabecalho, !temCabecalho);
    marcar(els.step2, temItens, temCabecalho && !temItens);
    marcar(els.step3, temLd, temItens && !temLd);
    marcar(els.step4, false, temItens);
    if (els.step2Note) els.step2Note.textContent = temItens ? `${state.rows.length} item(ns) na solicitação` : "Nenhum documento na solicitação";
    if (els.step3Note) els.step3Note.textContent = temLd ? `${state.lds.filter((item) => !item.error).length} LD(s) prontas para consulta` : "Nenhuma LD anexada";
    if (els.step4Note) els.step4Note.textContent = temItens ? "Copiar as linhas ou gerar a planilha" : "Aguardando itens";
    if (els.ldNote) {
      els.ldNote.textContent = temLd
        ? `${state.lds.filter((item) => !item.error).length} LD(s) anexadas`
        : "Sem LD, alocação e status ficam em branco para preencher à mão.";
    }
  }

  function aplicarEmLote() {
    const alvo = state.rows.filter((linha) => linha._selected !== false);
    if (!alvo.length) { notify("Selecione ao menos um item.", "warn"); return; }
    const tipo = els.batchType.value;
    const responsavel = text(els.batchOwner.value);
    const inclusao = els.batchInclusion.value;
    const observacao = text(els.batchNote.value);
    if (!tipo && !responsavel && !inclusao && !observacao) { notify("Preencha ao menos um campo da barra para aplicar.", "warn"); return; }

    state.undo.push(state.rows.map((linha) => ({ ...linha })));
    if (state.undo.length > 10) state.undo.shift();
    alvo.forEach((linha) => {
      if (tipo) linha.requestType = tipo;
      if (responsavel) linha.owner = responsavel;
      if (inclusao) linha.needsLdInclusion = inclusao;
      // A observação é acrescentada, não substituída: a evidência da consulta à
      // LD é informação que ninguém deveria perder ao anotar algo.
      if (observacao) linha.observations = [linha.observations, observacao].filter(Boolean).join(" ");
    });
    els.batchNote.value = "";
    render();
    notify(`Aplicado a ${alvo.length} item(ns).`, "success");
  }

  function desfazerLote() {
    const anterior = state.undo.pop();
    if (!anterior) return;
    state.rows = anterior;
    render();
    notify("Alteração em lote desfeita.", "info");
  }

  function limpar() {
    if (state.rows.length && !window.confirm("Limpar esta solicitação? Os itens digitados serão perdidos.")) return;
    state.entries = [];
    state.rows = [];
    state.undo = [];
    if (els.paste) els.paste.value = "";
    if (els.saved) els.saved.textContent = "";
    render();
    notify("Solicitação limpa.", "info");
  }

  // ---------------------------------------------------------------------------
  // Saída
  // ---------------------------------------------------------------------------
  function selecionadas() {
    return state.rows.filter((linha) => linha._selected !== false);
  }

  async function copiar(comCabecalho) {
    const linhas = selecionadas();
    if (!linhas.length) { notify("Selecione ao menos um item.", "warn"); return; }
    const texto = Report().controlClipboardText(linhas, comCabecalho);
    try {
      await navigator.clipboard.writeText(texto);
      notify(`${linhas.length} linha(s) copiadas${comCabecalho ? " com cabeçalho" : ""}. Cole no Controle de Solicitações.`, "success");
    } catch (_) {
      notify("O navegador bloqueou a cópia automática. Use “Gerar Excel no padrão da planilha”.", "warn");
    }
  }

  /**
   * Planilha no padrão do Controle de Solicitações: as 26 colunas na ordem e
   * com a grafia da planilha oficial, cabeçalho na linha 5 e dados a partir da
   * 6 — a mesma estrutura do arquivo da rede, para colar sem rearrumar coluna.
   */
  async function gerarExcel() {
    const linhas = selecionadas();
    if (!linhas.length) { notify("Selecione ao menos um item.", "warn"); return; }
    els.excel.disabled = true;
    try {
      await root.GRCONModuleLoader.ensure("excel");
      const workbook = new root.ExcelJS.Workbook();
      workbook.creator = "GRCON";
      workbook.company = "CONSAG Engenharia";
      workbook.title = "Controle de Solicitações";
      const sheet = workbook.addWorksheet("Controle de Solicitações", { properties: { defaultRowHeight: 20 } });
      const numero = text(els.number && els.number.value);
      const lds = state.lds.filter((item) => !item.error).map((item) => item.name).join(" · ");
      Report().writeControlSheet(sheet, linhas, {
        title: numero ? `CONTROLE DE SOLICITAÇÕES · ${numero}` : "CONTROLE DE SOLICITAÇÕES",
        metadata: [
          `${linhas.length.toLocaleString("pt-BR")} item(ns)`,
          `itens ${linhas[0].item} a ${linhas[linhas.length - 1].item}`,
          lds ? `LD consultada: ${lds}` : "sem consulta à LD",
          new Date().toLocaleString("pt-BR"),
        ].join(" · "),
      });
      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const carimbo = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      link.href = url;
      link.download = `GRCON_SOLICITACOES_${numero ? `${numero.replace(/[^\w-]+/g, "_")}_` : ""}${carimbo}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      notify(`Planilha gerada com ${linhas.length} linha(s) no padrão do Controle de Solicitações.`, "success");
    } catch (erro) {
      notify((erro && erro.message) || "Não foi possível gerar a planilha.", "error");
    } finally {
      els.excel.disabled = false;
    }
  }

  async function salvar() {
    const Cloud = root.GrconSolicitacoesStorage;
    if (!Cloud || !Cloud.saveRequest) { notify("Armazenamento de solicitações indisponível.", "warn"); return; }
    const numero = text(els.number && els.number.value);
    if (!numero) {
      notify("Informe o número da solicitação antes de salvar.", "warn");
      if (els.number) els.number.focus();
      return;
    }
    const itens = selecionadas();
    if (!itens.length) { notify("Selecione ao menos um item.", "warn"); return; }
    els.save.disabled = true;
    els.saved.textContent = "Salvando…";
    try {
      const resultado = await Cloud.saveRequest({
        requestNumber: numero,
        receivedAtIso: els.received ? els.received.value : "",
        requester: text(els.requester && els.requester.value),
        owner: text(els.owner && els.owner.value),
        status: "recebido",
      }, itens);
      if (!resultado.ok) {
        els.saved.textContent = "";
        notify(resultado.error, "warn");
        return;
      }
      els.saved.textContent = `${itens.length} item(ns) salvos em ${numero}.`;
      window.dispatchEvent(new CustomEvent("grcon:requests-saved"));
      notify(`Solicitação ${numero} salva com ${itens.length} item(ns).`, "success");
    } finally {
      els.save.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Painel de acompanhamento
  //
  // Mostra o que está gravado na armazenamento independente, não o que está na tela: as
  // alterações feitas aqui valem para todos e passam pelo banco, que registra
  // cada uma no histórico do item.
  // ---------------------------------------------------------------------------
  const STATUS_ABERTOS = new Set(["rascunho", "recebido", "em_triagem", "aguardando_info", "pendente", "em_execucao", "aguardando_validacao"]);

  function rotuloStatus(codigo) {
    const encontrado = R().REQUEST_STATUSES.find((item) => item.code === codigo);
    return encontrado ? encontrado.label : (codigo || "—");
  }

  async function carregarPainel() {
    const Cloud = root.GrconSolicitacoesStorage;
    if (!Cloud || !Cloud.listRequestItems) return;
    if (els.painelReload) els.painelReload.disabled = true;
    try {
      state.painelItems = await Cloud.listRequestItems();
      state.painelSelected.clear();
      renderPainel();
    } finally {
      if (els.painelReload) els.painelReload.disabled = false;
    }
  }

  function itensDoPainel() {
    const busca = state.painelSearch.trim().toLowerCase();
    return state.painelItems.filter((item) => {
      if (state.painelStatus && item.status !== state.painelStatus) return false;
      if (state.painelOwner && (item.owner_name || "") !== state.painelOwner) return false;
      if (state.painelQuick === "abertos" && !STATUS_ABERTOS.has(item.status)) return false;
      if (state.painelQuick === "validar" && !item.needs_manual_validation) return false;
      if (state.painelQuick === "novos" && !/novo/i.test(item.classification || "")) return false;
      if (state.painelQuick === "sem-responsavel" && (item.owner_name || "").trim()) return false;
      if (state.painelQuick === "concluidos" && item.status !== "concluido") return false;
      if (busca) {
        const campos = [item.protocol, item.document, item.request_number, item.owner_name, item.type_code, item.requester];
        if (!campos.filter(Boolean).some((valor) => String(valor).toLowerCase().includes(busca))) return false;
      }
      return true;
    });
  }

  function renderPainel() {
    if (!els.painelTbody) return;
    const todos = state.painelItems;
    const visiveis = itensDoPainel();

    // Indicadores: contam o conjunto inteiro, não o filtrado — senão o painel
    // diria que não há pendências só porque o filtro escondeu.
    const conta = (fn) => todos.filter(fn).length;
    const indicadores = [
      ["Itens registrados", todos.length, ""],
      ["Em aberto", conta((i) => STATUS_ABERTOS.has(i.status)), "alerta"],
      ["Aguardando validação", conta((i) => i.needs_manual_validation), "alerta"],
      ["Documentos novos", conta((i) => /novo/i.test(i.classification || "")), ""],
      ["Sem responsável", conta((i) => !(i.owner_name || "").trim()), "erro"],
      ["Concluídos", conta((i) => i.status === "concluido"), "ok"],
    ];
    els.indicators.innerHTML = indicadores.map(([rotulo, valor, classe]) =>
      `<div class="${classe}"><span>${rotulo}</span><strong>${valor.toLocaleString("pt-BR")}</strong></div>`).join("");
    const abertos = conta((i) => STATUS_ABERTOS.has(i.status));
    [els.painelCount, els.tabCount, els.navCount].forEach((selo) => {
      if (!selo) return;
      selo.hidden = !abertos;
      selo.textContent = String(abertos);
    });

    els.painelEmpty.hidden = Boolean(todos.length);
    els.painelTableWrap.hidden = !todos.length;

    els.painelTbody.innerHTML = visiveis.map((item) => `<tr${item.needs_manual_validation ? ' class="precisa-validar"' : ""}>
      <td class="requests-col-check"><input aria-label="Selecionar ${escapeHtml(item.protocol)}" data-painel-select="${escapeHtml(item.protocol)}" type="checkbox"${state.painelSelected.has(item.protocol) ? " checked" : ""}/></td>
      <td><strong>${escapeHtml(item.protocol)}</strong></td>
      <td>${escapeHtml(item.request_number || "—")}</td>
      <td><code>${escapeHtml(item.document || "—")}</code></td>
      <td>${escapeHtml(item.type_code || "—")}</td>
      <td>${escapeHtml(item.owner_name || "—")}</td>
      <td>${escapeHtml(rotuloStatus(item.status))}</td>
      <td>${escapeHtml(item.classification || "—")}</td>
      <td>${escapeHtml((item.observations || "").slice(0, 90))}<button class="text-button requests-history-open" data-history="${escapeHtml(item.protocol)}" type="button">Histórico</button></td>
    </tr>`).join("");

    // Listas de filtro montadas a partir do que existe, não de uma lista fixa.
    if (els.painelStatusSelect && els.painelStatusSelect.options.length <= 1) {
      R().REQUEST_STATUSES.forEach((estado) => {
        const opcao = document.createElement("option");
        opcao.value = estado.code; opcao.textContent = estado.label;
        els.painelStatusSelect.appendChild(opcao);
        if (els.painelSetStatus) els.painelSetStatus.appendChild(opcao.cloneNode(true));
      });
    }
    const responsaveis = [...new Set(todos.map((i) => (i.owner_name || "").trim()).filter(Boolean))].sort();
    if (els.painelOwnerSelect && els.painelOwnerSelect.options.length - 1 !== responsaveis.length) {
      els.painelOwnerSelect.innerHTML = '<option value="">Todos</option>' +
        responsaveis.map((nome) => `<option>${escapeHtml(nome)}</option>`).join("");
      els.painelOwnerSelect.value = state.painelOwner;
    }

    els.painelBatch.hidden = !state.painelSelected.size;
    if (els.painelSelectedCount) els.painelSelectedCount.textContent = `${state.painelSelected.size} selecionado(s)`;
  }

  async function aplicarNoPainel() {
    const Cloud = root.GrconSolicitacoesStorage;
    if (!Cloud || !Cloud.updateRequestItems) return;
    const protocolos = [...state.painelSelected];
    if (!protocolos.length) return;
    const novoStatus = els.painelSetStatus ? els.painelSetStatus.value : "";
    const novoResponsavel = text(els.painelSetOwner && els.painelSetOwner.value);
    const nota = text(els.painelNote && els.painelNote.value);
    if (!novoStatus && !novoResponsavel) { notify("Escolha um status ou informe um responsável.", "warn"); return; }

    els.painelApply.disabled = true;
    try {
      // Uma chamada por campo: o banco grava o valor anterior e o novo em cada
      // item, e é isso que permite reconstruir depois quem mudou o quê.
      if (novoStatus) {
        const r = await Cloud.updateRequestItems(protocolos, "status", novoStatus, nota);
        if (!r.ok) { notify(r.error, "warn"); return; }
      }
      if (novoResponsavel) {
        const r = await Cloud.updateRequestItems(protocolos, "owner_name", novoResponsavel, nota);
        if (!r.ok) { notify(r.error, "warn"); return; }
      }
      if (els.painelNote) els.painelNote.value = "";
      notify(`${protocolos.length} item(ns) atualizados no aplicativo.`, "success");
      await carregarPainel();
    } finally {
      els.painelApply.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Histórico do item
  // ---------------------------------------------------------------------------
  function descreverEvento(evento) {
    const campos = {
      status: "Status", owner_name: "Responsável", type_code: "Descrição da solicitação",
      priority: "Prioridade", deadline: "Prazo", observations: "Observações",
      classification: "Classificação", needs_manual_validation: "Precisa de validação",
    };
    if (evento.action === "saved") return "Item gravado";
    const campo = campos[evento.field] || evento.field || "Alteração";
    return `${campo}: ${evento.old_value || "vazio"} → ${evento.new_value || "vazio"}`;
  }

  async function abrirHistorico(protocolo) {
    const Cloud = root.GrconSolicitacoesStorage;
    if (!Cloud || !Cloud.requestItemHistory) { notify("Armazenamento de solicitações indisponível.", "warn"); return; }
    els.historyProtocol.textContent = protocolo;
    els.historyBody.innerHTML = '<p class="requests-vazio">Carregando…</p>';
    els.history.hidden = false;
    const eventos = await Cloud.requestItemHistory(protocolo);
    if (!eventos.length) {
      els.historyBody.innerHTML = '<p class="requests-vazio">Nenhum registro para este item ainda.</p>';
      return;
    }
    els.historyBody.innerHTML = `<ol class="requests-history-list">${eventos.map((evento) => {
      const quando = evento.created_at ? new Date(evento.created_at).toLocaleString("pt-BR") : "";
      return `<li>
        <span class="requests-history-when">${escapeHtml(quando)}</span>
        <strong>${escapeHtml(descreverEvento(evento))}</strong>
        ${evento.note ? `<span class="requests-history-note">${escapeHtml(evento.note)}</span>` : ""}
      </li>`;
    }).join("")}</ol>`;
  }

  // ---------------------------------------------------------------------------
  // Tipos de solicitação
  // ---------------------------------------------------------------------------
  /**
   * Sem armazenamento independente configurada o GRCON é de uso local, e não há a quem
   * restringir. Tratar "sem área" como "não é proprietário" esconderia a
   * configuração de quem está trabalhando sozinho.
   */
  function ehProprietario() {
    const Cloud = root.GrconSolicitacoesStorage;
    if (!Cloud || !Cloud.state?.membership) return true;
    return Boolean(Cloud.canManageMembers && Cloud.canManageMembers());
  }

  async function carregarTipos() {
    const Cloud = root.GrconSolicitacoesStorage;
    if (Cloud && Cloud.getRequestTypes) {
      const salvos = await Cloud.getRequestTypes();
      state.tipos = R().requestTypeList(salvos && salvos.length ? salvos : null);
    } else {
      state.tipos = R().requestTypeList(null);
    }
    renderTipos();
    prepararFormulario();
  }

  function renderTipos() {
    if (!els.tiposTbody) return;
    const dono = ehProprietario();
    els.tiposTbody.innerHTML = state.tipos.map((tipo) => `<tr${tipo.active ? "" : ' class="requests-tipo-inativo"'}>
      <td><strong>${escapeHtml(tipo.label)}</strong></td>
      <td><code>${escapeHtml(tipo.code)}</code></td>
      <td>${escapeHtml(tipo.defaultAction || "—")}</td>
      <td>${tipo.defaultDeadlineDays ? `${tipo.defaultDeadlineDays} dia(s)` : "—"}</td>
      <td>${escapeHtml(tipo.defaultPriority)}</td>
      <td>${tipo.order}</td>
      <td>${tipo.active ? "sim" : "não"}</td>
      <td>${dono ? `<button class="text-button" data-tipo-edit="${escapeHtml(tipo.code)}" type="button">Editar</button>
           <button class="text-button danger" data-tipo-remove="${escapeHtml(tipo.code)}" type="button">Excluir</button>` : ""}</td>
    </tr>`).join("");
    if (els.tiposOwnerNote) els.tiposOwnerNote.hidden = dono;
    if (els.tipoForm) els.tipoForm.hidden = !dono;
  }

  function preencherFormularioTipo(codigo) {
    const tipo = state.tipos.find((item) => item.code === codigo);
    if (!tipo) return;
    els.tipoLabel.value = tipo.label;
    els.tipoCode.value = tipo.code;
    els.tipoAction.value = tipo.defaultAction || "";
    els.tipoDays.value = tipo.defaultDeadlineDays || "";
    els.tipoPriority.value = tipo.defaultPriority;
    els.tipoOrder.value = tipo.order;
    els.tipoLabel.focus();
  }

  async function salvarTipo() {
    const Cloud = root.GrconSolicitacoesStorage;
    if (!Cloud || !Cloud.saveRequestType) { notify("Armazenamento de solicitações indisponível.", "warn"); return; }
    const rotulo = text(els.tipoLabel.value);
    if (!rotulo) { notify("Informe o rótulo do tipo.", "warn"); els.tipoLabel.focus(); return; }
    els.tipoSave.disabled = true;
    try {
      const tipo = R().normalizeRequestType({
        label: rotulo,
        code: text(els.tipoCode.value),
        defaultAction: text(els.tipoAction.value),
        defaultDeadlineDays: els.tipoDays.value,
        defaultPriority: els.tipoPriority.value,
        order: els.tipoOrder.value,
      });
      const resultado = await Cloud.saveRequestType(tipo);
      if (!resultado.ok) { notify(resultado.error, "warn"); return; }
      [els.tipoLabel, els.tipoCode, els.tipoAction, els.tipoDays, els.tipoOrder].forEach((campo) => { campo.value = ""; });
      notify(`Tipo “${tipo.label}” salvo no aplicativo.`, "success");
      await carregarTipos();
    } finally {
      els.tipoSave.disabled = false;
    }
  }

  async function removerTipo(codigo) {
    const Cloud = root.GrconSolicitacoesStorage;
    if (!Cloud || !Cloud.deleteRequestType) { notify("Armazenamento de solicitações indisponível.", "warn"); return; }
    const tipo = state.tipos.find((item) => item.code === codigo);
    if (!window.confirm(`Excluir o tipo “${tipo ? tipo.label : codigo}”?\n\nSe ele já estiver em uso, será apenas desativado e as solicitações antigas ficam intactas.`)) return;
    const resultado = await Cloud.deleteRequestType(codigo);
    if (!resultado.ok) { notify(resultado.error, "warn"); return; }
    notify(`Tipo ${resultado.detalhe || "removido"}.`, "success");
    await carregarTipos();
  }

  function prepararFormulario() {
    if (els.type) {
      const rotulos = tiposAtivos();
      const atual = els.type.value;
      els.type.innerHTML = rotulos.map((rotulo) => `<option${rotulo === atual ? " selected" : ""}>${escapeHtml(rotulo)}</option>`).join("");
    }
    if (els.received && !els.received.value) els.received.value = new Date().toISOString().slice(0, 10);
  }

  function mostrarArea(area) {
    els.areaNova.hidden = area !== "nova";
    els.areaPainel.hidden = area !== "painel";
    els.areaTipos.hidden = area !== "tipos";
    document.querySelectorAll("[data-sol-area]").forEach((botao) => {
      botao.classList.toggle("active", botao.dataset.solArea === area);
    });
    if (area === "painel") carregarPainel();
    if (area === "tipos") carregarTipos();
  }

  // ---------------------------------------------------------------------------
  // Ligações
  // ---------------------------------------------------------------------------
  function ligar() {
    els.areaNova = $("#sol-area-nova");
    els.areaPainel = $("#sol-area-painel");
    els.areaTipos = $("#sol-area-tipos");
    if (!els.areaNova) return false;

    els.number = $("#sol-number");
    els.nextItem = $("#sol-next-item");
    els.owner = $("#sol-owner");
    els.received = $("#sol-received");
    els.requester = $("#sol-requester");
    els.type = $("#sol-type");
    els.origin = $("#sol-origin");
    els.family = $("#sol-family");
    els.status = $("#sol-status");
    els.path = $("#sol-path");
    els.email = $("#sol-email");
    els.drop = $("#sol-drop");
    els.files = $("#sol-files");
    els.fileList = $("#sol-file-list");
    els.paste = $("#sol-paste");
    els.pasteAdd = $("#sol-paste-add");
    els.pasteClipboard = $("#sol-paste-clipboard");
    els.blank = $("#sol-blank");
    els.docCount = $("#sol-doc-count");
    els.ldDrop = $("#sol-ld-drop");
    els.ldInput = $("#sol-ld-input");
    els.ldList = $("#sol-ld-list");
    els.ldRun = $("#sol-ld-run");
    els.ldClear = $("#sol-ld-clear");
    els.ldNote = $("#sol-ld-note");
    els.preview = $("#sol-preview");
    els.full = $("#sol-full");
    els.batchBar = $("#sol-batch-bar");
    els.batchCount = $("#sol-batch-count");
    els.batchType = $("#sol-batch-type");
    els.batchOwner = $("#sol-batch-owner");
    els.batchInclusion = $("#sol-batch-inclusion");
    els.batchNote = $("#sol-batch-note");
    els.batchApply = $("#sol-batch-apply");
    els.batchUndo = $("#sol-batch-undo");
    els.tableWrap = $("#sol-table-wrap");
    els.thead = $("#sol-thead");
    els.tbody = $("#sol-tbody");
    els.excel = $("#sol-excel");
    els.copy = $("#sol-copy");
    els.copyHeaders = $("#sol-copy-headers");
    els.save = $("#sol-save");
    els.saved = $("#sol-saved");
    els.clear = $("#sol-clear");
    els.step1 = $("#sol-step-1");
    els.step2 = $("#sol-step-2");
    els.step3 = $("#sol-step-3");
    els.step4 = $("#sol-step-4");
    els.step2Note = $("#sol-step-2-note");
    els.step3Note = $("#sol-step-3-note");
    els.step4Note = $("#sol-step-4-note");
    els.painelCount = $("#sol-painel-count");
    els.tabCount = $("#solicitacoes-tab-count");
    els.navCount = $("#ops-solicitacoes-count");
    els.indicators = $("#sol-indicators");
    els.painelTbody = $("#sol-painel-tbody");
    els.painelTableWrap = $("#sol-painel-table-wrap");
    els.painelEmpty = $("#sol-painel-empty");
    els.painelSearch = $("#sol-painel-search");
    els.painelStatusSelect = $("#sol-painel-status");
    els.painelOwnerSelect = $("#sol-painel-owner");
    els.painelClear = $("#sol-painel-clear");
    els.painelReload = $("#sol-painel-reload");
    els.painelAll = $("#sol-painel-all");
    els.painelBatch = $("#sol-painel-batch");
    els.painelSelectedCount = $("#sol-painel-selected");
    els.painelSetStatus = $("#sol-painel-set-status");
    els.painelSetOwner = $("#sol-painel-set-owner");
    els.painelNote = $("#sol-painel-note");
    els.painelApply = $("#sol-painel-apply");
    els.history = $("#sol-history");
    els.historyProtocol = $("#sol-history-protocol");
    els.historyBody = $("#sol-history-body");
    els.historyClose = $("#sol-history-close");
    els.tipoForm = $("#sol-tipo-form");
    els.tiposOwnerNote = $("#sol-tipos-owner-note");
    els.tiposTbody = $("#sol-tipos-tbody");
    els.tipoLabel = $("#sol-tipo-label");
    els.tipoCode = $("#sol-tipo-code");
    els.tipoAction = $("#sol-tipo-action");
    els.tipoDays = $("#sol-tipo-days");
    els.tipoPriority = $("#sol-tipo-priority");
    els.tipoOrder = $("#sol-tipo-order");
    els.tipoSave = $("#sol-tipo-save");

    // Arquivos do pedido
    els.drop.addEventListener("click", () => els.files.click());
    els.drop.addEventListener("keydown", (evento) => {
      if (evento.key === "Enter" || evento.key === " ") { evento.preventDefault(); els.files.click(); }
    });
    els.files.addEventListener("change", (evento) => { anexarArquivos(evento.target.files); evento.target.value = ""; });
    ["dragenter", "dragover"].forEach((tipo) => els.drop.addEventListener(tipo, (evento) => {
      evento.preventDefault(); els.drop.classList.add("is-over");
    }));
    ["dragleave", "drop"].forEach((tipo) => els.drop.addEventListener(tipo, (evento) => {
      evento.preventDefault(); els.drop.classList.remove("is-over");
    }));
    els.drop.addEventListener("drop", (evento) => anexarArquivos(evento.dataTransfer && evento.dataTransfer.files));
    els.fileList.addEventListener("click", (evento) => {
      const botao = evento.target.closest("[data-remove-file]");
      if (!botao) return;
      const comArquivo = state.entries.filter((item) => item.fileName);
      const alvo = comArquivo[Number(botao.dataset.removeFile)];
      if (!alvo) return;
      state.entries = state.entries.filter((item) => item !== alvo);
      regerar();
    });

    els.pasteAdd.addEventListener("click", () => colar(els.paste.value));
    els.paste.addEventListener("keydown", (evento) => {
      if ((evento.ctrlKey || evento.metaKey) && evento.key === "Enter") { evento.preventDefault(); colar(els.paste.value); }
    });
    els.pasteClipboard.addEventListener("click", async () => {
      try {
        const texto = await navigator.clipboard.readText();
        if (!texto) { notify("A área de transferência está vazia.", "warn"); return; }
        colar(texto);
      } catch (_) {
        notify("O navegador bloqueou a leitura da área de transferência. Cole no campo acima.", "warn");
      }
    });
    els.blank.addEventListener("click", () => {
      state.entries.push({ document: "", requestedTitle: "", fileName: "", source: "item em branco" });
      regerar();
    });

    // LD opcional
    els.ldDrop.addEventListener("click", () => els.ldInput.click());
    els.ldDrop.addEventListener("keydown", (evento) => {
      if (evento.key === "Enter" || evento.key === " ") { evento.preventDefault(); els.ldInput.click(); }
    });
    els.ldInput.addEventListener("change", (evento) => { anexarLds(evento.target.files); evento.target.value = ""; });
    ["dragenter", "dragover"].forEach((tipo) => els.ldDrop.addEventListener(tipo, (evento) => {
      evento.preventDefault(); els.ldDrop.classList.add("is-over");
    }));
    ["dragleave", "drop"].forEach((tipo) => els.ldDrop.addEventListener(tipo, (evento) => {
      evento.preventDefault(); els.ldDrop.classList.remove("is-over");
    }));
    els.ldDrop.addEventListener("drop", (evento) => anexarLds(evento.dataTransfer && evento.dataTransfer.files));
    els.ldList.addEventListener("click", (evento) => {
      const botao = evento.target.closest("[data-remove-ld]");
      if (!botao) return;
      state.lds = state.lds.filter((item) => item.id !== botao.dataset.removeLd);
      reconstruirIndice();
      render();
    });
    els.ldClear.addEventListener("click", () => {
      state.lds = [];
      state.index = null;
      render();
      notify("Todas as LDs foram removidas. O que já foi consultado continua nas linhas.", "info");
    });
    els.ldRun.addEventListener("click", consultarNaLd);

    // Tabela
    els.tbody.addEventListener("change", (evento) => {
      const selecao = evento.target.closest("[data-sol-select]");
      if (selecao) {
        const linha = state.rows[Number(selecao.dataset.solSelect)];
        if (linha) { linha._selected = selecao.checked; atualizarContagem(); }
        return;
      }
      const campo = evento.target.closest("[data-sol-field]");
      if (!campo) return;
      const linha = state.rows[Number(campo.dataset.solRow)];
      if (linha) linha[campo.dataset.solField] = campo.value;
    });
    // Delegado: o cabeçalho é reescrito ao trocar de modo, e um ouvinte preso ao
    // elemento antigo pararia de funcionar sem dar sinal nenhum.
    els.tableWrap.addEventListener("change", (evento) => {
      const todos = evento.target.closest("#sol-select-all");
      if (!todos) return;
      state.rows.forEach((linha) => { linha._selected = todos.checked; });
      render();
    });
    els.full.addEventListener("change", render);
    els.batchApply.addEventListener("click", aplicarEmLote);
    els.batchUndo.addEventListener("click", desfazerLote);

    // Saída
    els.excel.addEventListener("click", gerarExcel);
    els.copy.addEventListener("click", () => copiar(false));
    els.copyHeaders.addEventListener("click", () => copiar(true));
    els.save.addEventListener("click", salvar);
    els.clear.addEventListener("click", limpar);

    // Cabeçalho: mudar um campo reaplica nas linhas enquanto não houve edição em
    // lote, para uma correção de data não apagar o trabalho já feito na tabela.
    [els.nextItem, els.owner, els.received, els.requester, els.type, els.origin, els.path,
      els.family, els.email, els.status].forEach((campo) => campo && campo.addEventListener("input", () => {
      if (state.undo.length) {
        notify("A tabela já foi editada: o cabeçalho não é reaplicado sozinho. Use a barra de ações em lote.", "info");
        return;
      }
      regerar();
    }));
    if (els.number) els.number.addEventListener("input", atualizarPassos);

    // Sub-áreas
    document.querySelectorAll("[data-sol-area]").forEach((botao) =>
      botao.addEventListener("click", () => mostrarArea(botao.dataset.solArea)));

    // Painel
    els.painelReload.addEventListener("click", carregarPainel);
    els.painelApply.addEventListener("click", aplicarNoPainel);
    els.painelSearch.addEventListener("input", (evento) => { state.painelSearch = evento.target.value; renderPainel(); });
    els.painelStatusSelect.addEventListener("change", (evento) => { state.painelStatus = evento.target.value; renderPainel(); });
    els.painelOwnerSelect.addEventListener("change", (evento) => { state.painelOwner = evento.target.value; renderPainel(); });
    els.painelClear.addEventListener("click", () => {
      state.painelQuick = "todos"; state.painelSearch = ""; state.painelStatus = ""; state.painelOwner = "";
      els.painelSearch.value = ""; els.painelStatusSelect.value = ""; els.painelOwnerSelect.value = "";
      document.querySelectorAll("#sol-area-painel [data-quick]").forEach((chip) => chip.classList.toggle("active", chip.dataset.quick === "todos"));
      renderPainel();
    });
    document.querySelectorAll("#sol-area-painel [data-quick]").forEach((chip) => chip.addEventListener("click", () => {
      state.painelQuick = chip.dataset.quick;
      document.querySelectorAll("#sol-area-painel [data-quick]").forEach((outro) => outro.classList.toggle("active", outro === chip));
      renderPainel();
    }));
    els.painelTbody.addEventListener("click", (evento) => {
      const botao = evento.target.closest("[data-history]");
      if (botao) abrirHistorico(botao.dataset.history);
    });
    els.painelTbody.addEventListener("change", (evento) => {
      const caixa = evento.target.closest("[data-painel-select]");
      if (!caixa) return;
      if (caixa.checked) state.painelSelected.add(caixa.dataset.painelSelect);
      else state.painelSelected.delete(caixa.dataset.painelSelect);
      renderPainel();
    });
    els.painelAll.addEventListener("change", () => {
      state.painelSelected.clear();
      if (els.painelAll.checked) itensDoPainel().forEach((item) => state.painelSelected.add(item.protocol));
      renderPainel();
    });
    els.historyClose.addEventListener("click", () => { els.history.hidden = true; });
    // Depois de gravar, o painel deixa de estar desatualizado.
    window.addEventListener("grcon:requests-saved", carregarPainel);

    // Tipos
    els.tipoSave.addEventListener("click", salvarTipo);
    els.tiposTbody.addEventListener("click", (evento) => {
      const editar = evento.target.closest("[data-tipo-edit]");
      if (editar) { preencherFormularioTipo(editar.dataset.tipoEdit); return; }
      const remover = evento.target.closest("[data-tipo-remove]");
      if (remover) removerTipo(remover.dataset.tipoRemove);
    });

    carregarTipos();
    carregarPainel();
    render();
    return true;
  }

  root.GrconSolicitacoesUi = Object.freeze({
    init: ligar,
    state,
    /** As linhas em edição, para quem exporta por modelo na aba de Consultas. */
    currentRows: () => state.rows.filter((linha) => linha._selected !== false),
    _debug: { linhasDoCabecalho, cabecalho },
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ligar, { once: true });
  } else {
    ligar();
  }
})(window);
