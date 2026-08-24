/**
 * GRCON Flow — ajustes operacionais 2026-08-24.
 *
 * Mantém as regras em um complemento pequeno para não duplicar os módulos
 * principais: 30 anexos, DWG, triagem server-side sem repetição imediata e UX
 * clara para a equipe registrar pedidos em nome de terceiros.
 */
(function (root) {
  "use strict";

  const Api = root.FlowApi;
  const Ui = root.FlowUi;
  if (!Api || !Ui) return;

  const MAX_ANEXOS = 30;
  const EXTENSOES = Object.freeze(["pdf", "xls", "xlsx", "xlsm", "doc", "docx", "dwg"]);
  const MIME = Object.freeze({
    pdf: "application/pdf",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xlsm: "application/vnd.ms-excel.sheet.macroenabled.12",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    dwg: "application/acad",
  });

  function texto(valor) {
    return valor === null || valor === undefined ? "" : String(valor).trim();
  }

  function extensao(arquivo) {
    const nome = texto(arquivo && arquivo.name).toLowerCase();
    const ponto = nome.lastIndexOf(".");
    return ponto >= 0 ? nome.slice(ponto + 1) : "";
  }

  function mensagemErro(erro) {
    const bruto = texto(erro && (erro.message || erro.error_description || erro));
    if (/row-level security|permission denied|Sem permissão/i.test(bruto)) {
      return "Seu perfil não tem permissão para anexar este arquivo.";
    }
    if (/maximum allowed size|mais de 10 MB|size_valid/i.test(bruto)) {
      return "Cada arquivo pode ter no máximo 10 MB.";
    }
    if (/Formato de anexo|extension_valid|mime_valid/i.test(bruto)) {
      return "Envie arquivos PDF, Excel, Word ou DWG.";
    }
    return bruto || "Não foi possível enviar o arquivo.";
  }

  function validarArquivo(arquivo) {
    if (!arquivo || !texto(arquivo.name)) return "Escolha um arquivo válido.";
    const ext = extensao(arquivo);
    if (!EXTENSOES.includes(ext)) {
      return `“${arquivo.name}” não é PDF, Excel, Word ou DWG.`;
    }
    if (!Number(arquivo.size)) return `“${arquivo.name}” está vazio.`;
    const limiteMb = Number(Api.config.uploadMaxMb) || 10;
    if (arquivo.size > limiteMb * 1024 * 1024) {
      return `“${arquivo.name}” tem mais de ${limiteMb} MB.`;
    }
    return null;
  }

  // FlowApi é congelado apenas no primeiro nível; o contrato de anexos é um
  // objeto próprio e pode receber estas regras sem reescrever a camada inteira.
  if (Api.anexos) {
    Api.anexos.maximo = MAX_ANEXOS;
    Api.anexos.extensoes = EXTENSOES;
    Api.anexos.accept = EXTENSOES.map((ext) => `.${ext}`).join(",");
    Api.anexos.validar = validarArquivo;

    Api.anexos.enviar = async function enviarAnexoAjustado(requestId, arquivo, itemId = null) {
      const erroArquivo = validarArquivo(arquivo);
      if (erroArquivo) return { data: null, error: erroArquivo };

      const ext = extensao(arquivo);
      const nomeSeguro = arquivo.name.replace(/[^\w.\- ]+/g, "_");
      const identificador = root.crypto && typeof root.crypto.randomUUID === "function"
        ? root.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const caminho = `${requestId}/${identificador}-${nomeSeguro}`;

      try {
        const upload = await Api.client.storage.from("flow-anexos").upload(caminho, arquivo, {
          contentType: MIME[ext] || "application/octet-stream",
          upsert: false,
        });
        if (upload.error) return { data: null, error: mensagemErro(upload.error) };

        const registro = await Api.client.rpc("flow_register_attachment", {
          p_request_id: requestId,
          p_item_id: itemId,
          p_file_name: arquivo.name,
          p_storage_path: caminho,
          p_mime_type: MIME[ext] || "application/octet-stream",
          p_size_bytes: arquivo.size,
        });

        if (registro.error) {
          await Api.client.storage.from("flow-anexos").remove([caminho]);
          return { data: null, error: mensagemErro(registro.error) };
        }
        return { data: registro.data, error: null };
      } catch (erro) {
        return { data: null, error: mensagemErro(erro) };
      }
    };
  }

  // O servidor já tria no ato da criação. A tela antiga chama a triagem logo em
  // seguida; pulamos somente essa repetição imediata. Reprocessamentos manuais do
  // painel continuam executando normalmente.
  const autoTriados = new Set();
  if (Api.solicitacoes && Api.triagem) {
    const criarOriginal = Api.solicitacoes.criar.bind(Api.solicitacoes);
    const triarOriginal = Api.triagem.solicitacao.bind(Api.triagem);

    Api.solicitacoes.criar = async function criarComTriagem(dados) {
      const retorno = await criarOriginal(dados);
      if (retorno && retorno.data && retorno.data.triage_completed && retorno.data.id) {
        autoTriados.add(retorno.data.id);
      }
      return retorno;
    };

    Api.triagem.solicitacao = async function triarSemDuplicar(id) {
      if (autoTriados.has(id)) {
        autoTriados.delete(id);
        return { data: { already_triaged: true }, error: null };
      }
      return triarOriginal(id);
    };
  }

  // Vocabulário do painel: a classificação passa a responder primeiro à
  // pergunta operacional mais importante — é novo ou já existe na LD?
  if (Ui.CLASSIFICACOES) {
    if (Ui.CLASSIFICACOES.PRONTO) Ui.CLASSIFICACOES.PRONTO.rotulo = "JÁ EXISTE · alocado";
    if (Ui.CLASSIFICACOES.ACAO_NECESSARIA) Ui.CLASSIFICACOES.ACAO_NECESSARIA.rotulo = "JÁ EXISTE · sem alocação";
    if (Ui.CLASSIFICACOES.VALIDAR) Ui.CLASSIFICACOES.VALIDAR.rotulo = "JÁ EXISTE · validar divergência";
    if (Ui.CLASSIFICACOES.NAO_LOCALIZADO) Ui.CLASSIFICACOES.NAO_LOCALIZADO.rotulo = "NOVO · não consta nas LDs";
    if (Ui.CLASSIFICACOES.IDENTIFICACAO_PENDENTE) Ui.CLASSIFICACOES.IDENTIFICACAO_PENDENTE.rotulo = "PENDENTE · identificar código";
    if (Ui.CLASSIFICACOES.POSSIVEIS_CORRESPONDENCIAS) Ui.CLASSIFICACOES.POSSIVEIS_CORRESPONDENCIAS.rotulo = "POSSÍVEL EXISTENTE · confirmar";
  }

  function ajustarFormularioSolicitante() {
    const nome = document.getElementById("sol-nome");
    const contato = document.getElementById("sol-contato");
    if (!nome || !contato) return;

    const card = nome.closest(".flow-card");
    if (!card || card.dataset.terceiroAjustado === "1") return;
    card.dataset.terceiroAjustado = "1";

    const equipe = Api.auth && Api.auth.ehEquipe && Api.auth.ehEquipe();
    const titulo = card.querySelector(".flow-card-head h3");
    if (titulo) titulo.textContent = equipe ? "Dados do solicitante" : "Seus dados";

    const labelNome = nome.closest("label");
    const labelContato = contato.closest("label");
    if (labelNome) {
      const span = labelNome.querySelector(":scope > span");
      if (span && equipe) span.childNodes[0].textContent = "Nome do solicitante";
    }
    if (labelContato) {
      const span = labelContato.querySelector(":scope > span");
      if (span && equipe) span.childNodes[0].textContent = "E-mail / contato do solicitante";
      const small = labelContato.querySelector("small");
      if (small && equipe) small.textContent = "Pode ser um e-mail de pessoa que ainda não possui cadastro no GRCON Flow.";
    }

    if (equipe) {
      const aviso = document.createElement("div");
      aviso.className = "flow-aviso ok";
      aviso.style.marginBottom = ".85rem";
      aviso.innerHTML = "<strong>Pedido em nome de outra pessoa</strong><br>Você pode substituir o nome, a área e o e-mail abaixo. A pessoa não precisa ter conta no aplicativo; seu usuário ficará registrado somente na auditoria como quem lançou a solicitação.";
      const grade = card.querySelector(".flow-grid");
      if (grade) card.insertBefore(aviso, grade);
    }
  }

  function ajustarTextoAnexos() {
    document.querySelectorAll(".flow-drop").forEach((area) => {
      if (area.dataset.dwgAjustado === "1") return;
      const textoAtual = area.textContent || "";
      if (!/PDF|Excel|Word/i.test(textoAtual)) return;
      area.dataset.dwgAjustado = "1";
      area.setAttribute("aria-label", "Escolher ou arrastar anexos em PDF, Excel, Word ou DWG");
      area.querySelectorAll("span").forEach((span) => {
        if (/PDF, Excel ou Word/i.test(span.textContent || "")) {
          span.textContent = (span.textContent || "")
            .replace("PDF, Excel ou Word", "PDF, Excel, Word ou DWG")
            .replace(/até \d+ arquivos/i, `até ${MAX_ANEXOS} arquivos`);
        }
      });
    });
  }

  const observar = new MutationObserver(() => {
    ajustarFormularioSolicitante();
    ajustarTextoAnexos();
  });
  observar.observe(document.documentElement, { childList: true, subtree: true });
  ajustarFormularioSolicitante();
  ajustarTextoAnexos();
})(window);
