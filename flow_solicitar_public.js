/**
 * GRCON Flow — proteção da experiência pública da Nova Solicitação.
 *
 * Carregado somente em solicitar.html. Por isso:
 * - melhora a leitura de códigos nos nomes dos arquivos sem alterar o painel;
 * - esconde detalhes técnicos do solicitante, mantendo-os no console para diagnóstico;
 * - usa MIME binário genérico para DWG, aceito pelo bucket e mais compatível com browsers.
 */
(function (root) {
  "use strict";

  const Api = root.FlowApi;
  const BaseDocs = root.FlowDocs;
  if (!Api || !BaseDocs) return;

  const FILE_EXTENSIONS = /\.(?:pdf|docx?|xlsx?|xlsm|dwg|jpe?g|png|webp|heic|heif)$/i;
  const SAFE_ERROR_PATTERNS = [
    /limite de \d+ anexos/i,
    /no máximo \d+ MB/i,
    /tem mais de \d+ MB/i,
    /arquivo.*vazio/i,
    /LI\/MC.*N-1710/i,
    /PDF.*Excel/i,
    /já possui o PDF/i,
    /já possui o Excel/i,
    /formato.*não permitido/i,
  ];

  function texto(valor) {
    return valor === null || valor === undefined ? "" : String(valor).trim();
  }

  function nomeBase(nome) {
    return texto(nome).split(/[\\/]/).pop().replace(FILE_EXTENSIONS, "").trim();
  }

  /**
   * O arquivo pode vir como:
   *   DE-5290.00-22313-142-C1O-075_A - ANDAIME EM BALANÇO 1,5m x 1,5m.dwg
   *   DE-5290.00-22313-142-C1O-075_A ANDAIME EM BALANÇO.pdf
   *
   * O código nunca contém espaço; portanto o título não pode contaminar a chave
   * usada na LD. A grafia informada (inclusive revisão/sufixo incorreto) é
   * preservada e o servidor faz a busca flexível contra o código-base da LD.
   */
  function codigoETituloDoArquivo(nomeArquivo) {
    const base = nomeBase(nomeArquivo);
    if (!base) return { codigo: "", titulo: "" };

    const candidatos = [];
    const separador = base.search(/\s+(?:-|–|—)\s+/);
    if (separador > 0) candidatos.push(base.slice(0, separador).trim());

    const primeiroToken = base.split(/\s+/)[0];
    if (primeiroToken) candidatos.push(primeiroToken);

    // Mantém compatibilidade com o leitor já usado pelo projeto para nomes
    // formados apenas por código + sufixo SIGEM.
    const motor = root.GrconRequestsCore;
    if (motor && typeof motor.documentFromFileName === "function") {
      const lido = motor.documentFromFileName(nomeArquivo);
      if (lido && lido.document) candidatos.push(texto(lido.document));
    }

    const codigo = candidatos.find((candidato) =>
      candidato && BaseDocs.pareceCodigo && BaseDocs.pareceCodigo(candidato)
    ) || "";

    if (!codigo) return { codigo: "", titulo: "" };

    let titulo = base.slice(base.indexOf(codigo) + codigo.length).trim();
    titulo = titulo.replace(/^(?:-|–|—)\s*/, "").trim();
    return { codigo, titulo };
  }

  function deArquivosSeguro(arquivos) {
    return Array.from(arquivos || []).map((arquivo) => {
      const extraido = codigoETituloDoArquivo(arquivo && arquivo.name);
      if (extraido.codigo) {
        return BaseDocs.itemDeCodigo(extraido.codigo, {
          titulo: extraido.titulo,
          arquivo: arquivo.name,
        });
      }
      return {
        ...BaseDocs.itemDeTitulo("", arquivo && arquivo.name),
        file_name: texto(arquivo && arquivo.name),
      };
    });
  }

  // FlowDocs é congelado de propósito; substituímos a referência global por uma
  // cópia igualmente congelada antes de flow_solicitar.js capturá-la.
  root.FlowDocs = Object.freeze({ ...BaseDocs, deArquivos: deArquivosSeguro });

  function mensagemPublica(erro, arquivo) {
    const bruto = texto(erro);
    if (!bruto) return `Não foi possível enviar “${texto(arquivo && arquivo.name) || "o arquivo"}”. Tente novamente.`;
    if (SAFE_ERROR_PATTERNS.some((padrao) => padrao.test(bruto))) return bruto;
    console.error("[GRCON Flow · detalhe técnico de upload]", {
      arquivo: texto(arquivo && arquivo.name),
      erro: bruto,
    });
    return `Não foi possível enviar “${texto(arquivo && arquivo.name) || "o arquivo"}”. Tente novamente.`;
  }

  async function enviarDwg(requestId, arquivo, itemId) {
    const nomeSeguro = arquivo.name.replace(/[^\w.\- ]+/g, "_");
    const identificador = root.crypto && typeof root.crypto.randomUUID === "function"
      ? root.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const caminho = `${requestId}/${identificador}-${nomeSeguro}`;
    const mimeType = "application/octet-stream";

    try {
      const upload = await Api.client.storage.from("flow-anexos").upload(caminho, arquivo, {
        contentType: mimeType,
        upsert: false,
      });
      if (upload.error) {
        return { data: null, error: mensagemPublica(upload.error, arquivo) };
      }

      const registro = await Api.client.rpc("flow_register_attachment", {
        p_request_id: requestId,
        p_item_id: itemId || null,
        p_file_name: arquivo.name,
        p_storage_path: caminho,
        p_mime_type: mimeType,
        p_size_bytes: arquivo.size,
      });
      if (registro.error) {
        await Api.client.storage.from("flow-anexos").remove([caminho]);
        return { data: null, error: mensagemPublica(registro.error, arquivo) };
      }
      return { data: registro.data, error: null };
    } catch (erro) {
      return { data: null, error: mensagemPublica(erro, arquivo) };
    }
  }

  // Na Nova Solicitação, nenhum detalhe de SQL/PostgREST/RLS é mostrado ao
  // usuário. O painel continua usando o FlowApi original e pode diagnosticar.
  if (Api.anexos && typeof Api.anexos.enviar === "function") {
    const enviarOriginal = Api.anexos.enviar.bind(Api.anexos);
    Api.anexos.enviar = async function enviarPublico(requestId, arquivo, itemId = null) {
      const extensao = texto(arquivo && arquivo.name).toLowerCase().split(".").pop();
      const retorno = extensao === "dwg"
        ? await enviarDwg(requestId, arquivo, itemId)
        : await enviarOriginal(requestId, arquivo, itemId);
      if (retorno && retorno.error) {
        return { ...retorno, error: mensagemPublica(retorno.error, arquivo) };
      }
      return retorno;
    };
  }

  function erroTecnicoParaPublico(erro, fallback) {
    const bruto = texto(erro);
    if (!bruto) return null;
    if (SAFE_ERROR_PATTERNS.some((padrao) => padrao.test(bruto))) return bruto;
    console.error("[GRCON Flow · detalhe técnico]", bruto);
    return fallback;
  }

  if (Api.triagem && typeof Api.triagem.solicitacao === "function") {
    const triarOriginal = Api.triagem.solicitacao.bind(Api.triagem);
    Api.triagem.solicitacao = async function triarPublico(id) {
      const retorno = await triarOriginal(id);
      if (retorno && retorno.error) {
        return {
          ...retorno,
          error: erroTecnicoParaPublico(
            retorno.error,
            "A conferência automática ficou pendente. A equipe continuará o atendimento pelo protocolo registrado."
          ),
        };
      }
      return retorno;
    };
  }

  if (Api.solicitacoes && typeof Api.solicitacoes.criar === "function") {
    const criarOriginal = Api.solicitacoes.criar.bind(Api.solicitacoes);
    Api.solicitacoes.criar = async function criarPublico(dados) {
      const retorno = await criarOriginal(dados);
      if (retorno && retorno.error) {
        return {
          ...retorno,
          error: erroTecnicoParaPublico(
            retorno.error,
            "Não foi possível registrar a solicitação agora. Tente novamente; se continuar, procure a equipe do GRCON."
          ),
        };
      }
      return retorno;
    };
  }

  // Mantém a capacidade de trocar nome/e-mail do solicitante sem ocupar a tela
  // com a explicação operacional que a equipe já conhece.
  const removerAvisoTerceiro = () => {
    document.querySelectorAll(".flow-aviso.ok").forEach((aviso) => {
      const titulo = aviso.querySelector("strong");
      if (titulo && texto(titulo.textContent) === "Pedido em nome de outra pessoa") aviso.remove();
    });
  };
  const app = document.getElementById("app");
  if (app) new MutationObserver(removerAvisoTerceiro).observe(app, { childList: true, subtree: true });
  removerAvisoTerceiro();
})(window);
