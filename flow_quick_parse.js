/**
 * GRCON Flow — leitura conservadora de mensagens para o Registro rápido.
 *
 * Tudo acontece no navegador. O texto colado não sai para IA ou serviço
 * externo: só os campos que a pessoa revisar seguem para a solicitação.
 */
(function (root) {
  "use strict";

  const Docs = root.FlowDocs;

  function texto(valor) {
    return valor === null || valor === undefined ? "" : String(valor).trim();
  }

  function semAcentos(valor) {
    return texto(valor).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }

  function linhasDe(valor) {
    return String(valor || "")
      .replace(/\u00a0/g, " ")
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((linha) => linha.trim());
  }

  function emailEm(valor) {
    const achado = texto(valor).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return achado ? achado[0] : "";
  }

  function limparNome(valor) {
    return texto(valor)
      .replace(/<[^>]*>/g, " ")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, " ")
      .replace(/\s*[|;]\s*.*/, "")
      .replace(/\s{2,}/g, " ")
      .replace(/^["']|["']$/g, "")
      .trim();
  }

  function valorRotulado(linha, rotulos) {
    const padrao = new RegExp(`^(?:${rotulos})\\s*[:\\-]\\s*(.+)$`, "i");
    const achado = texto(linha).match(padrao);
    return achado ? texto(achado[1]) : "";
  }

  function pareceLinhaDePessoa(valor) {
    const linha = texto(valor);
    if (!linha || linha.length < 3 || linha.length > 80) return false;
    if (/[:@/\\]|\d{3,}/.test(linha)) return false;
    const palavras = linha.split(/\s+/).filter(Boolean);
    return palavras.length >= 2 && palavras.length <= 7 && palavras.every((parte) => /^[\p{L}.'-]+$/u.test(parte));
  }

  function ehCabecalhoDeEmail(linha) {
    return /^(?:de|from|enviado|sent|para|to|cc|cco|bcc|assunto|subject|responder para|reply-to)\s*:/i.test(linha);
  }

  function ehLinhaRotulada(linha) {
    return /^(?:nome|solicitante|requisitante|contato|e-?mail|ramal|telefone|área|area|setor|departamento)\s*[:\-]/i.test(linha);
  }

  function dadosDoCabecalho(linhas) {
    let nome = "";
    let contato = "";
    let area = "";
    let assunto = "";
    let canal = "texto";
    const removidas = new Set();

    linhas.forEach((linha, indice) => {
      const remetente = valorRotulado(linha, "de|from|remetente");
      const solicitante = valorRotulado(linha, "nome|solicitante|requisitante");
      const contatoRotulado = valorRotulado(linha, "contato|e-?mail|ramal|telefone");
      const areaRotulada = valorRotulado(linha, "área|area|setor|departamento");
      const assuntoRotulado = valorRotulado(linha, "assunto|subject");

      if (remetente) {
        canal = "outlook";
        nome = nome || limparNome(remetente);
        contato = contato || emailEm(remetente);
        removidas.add(indice);
      } else if (solicitante) {
        nome = nome || limparNome(solicitante);
        contato = contato || emailEm(solicitante);
        removidas.add(indice);
      }
      if (contatoRotulado) {
        contato = contato || emailEm(contatoRotulado) || contatoRotulado;
        removidas.add(indice);
      }
      if (areaRotulada) {
        area = area || areaRotulada;
        removidas.add(indice);
      }
      if (assuntoRotulado) {
        assunto = assunto || assuntoRotulado;
        removidas.add(indice);
      }
      if (/^(?:enviado|sent|para|to|cc|cco|bcc|responder para|reply-to)\s*:/i.test(linha)) {
        canal = "outlook";
        removidas.add(indice);
      }
    });

    if (!contato) contato = emailEm(linhas.join("\n"));

    // Cópia comum do Teams: nome numa linha e horário na seguinte, ou ambos
    // na mesma linha. Só aceitamos quando o nome tem aparência de pessoa.
    const primeiras = linhas.map((linha, indice) => ({ linha, indice })).filter((item) => item.linha).slice(0, 4);
    const hora = /^(?:(?:hoje|ontem)\s+)?(?:\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\s+)?\d{1,2}:\d{2}$/i;
    if (!nome && primeiras.length >= 2 && pareceLinhaDePessoa(primeiras[0].linha) && hora.test(primeiras[1].linha)) {
      nome = primeiras[0].linha;
      canal = "teams";
      removidas.add(primeiras[0].indice);
      removidas.add(primeiras[1].indice);
    } else if (!nome && primeiras.length) {
      const combinado = primeiras[0].linha.match(/^(.+?)\s+(\d{1,2}:\d{2})$/);
      if (combinado && pareceLinhaDePessoa(combinado[1])) {
        nome = texto(combinado[1]);
        canal = "teams";
        removidas.add(primeiras[0].indice);
      }
    }

    return { nome, contato, area, assunto, canal, removidas };
  }

  function candidatoDeArquivo(token) {
    if (!/\.(?:pdf|xlsx?|xlsm|docx?|dwg)$/i.test(token) || !Docs || !Docs.deArquivos) return "";
    const [item] = Docs.deArquivos([{ name: token }]);
    return texto(item && item.document);
  }

  function extrairDocumentos(linhas) {
    if (!Docs || !Docs.pareceCodigo) return [];
    const vistos = new Set();
    const documentos = [];

    linhas.forEach((linha) => {
      const tokens = linha.match(/[A-Za-z0-9][A-Za-z0-9._\-/]{6,}/g) || [];
      tokens.forEach((bruto) => {
        const token = bruto.replace(/[.,;:!?]+$/, "");
        if (!/[A-Za-z]/.test(token) || /@/.test(token) || /^https?\//i.test(token)) return;
        if (/^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/.test(token)) return;
        // Uma tag curta como VM-322567 é referência útil dentro do título,
        // mas não é, sozinha, código documental. Exigimos ao menos dois
        // separadores antes de encaminhar o token para a busca nas LDs.
        if ((token.match(/[-_./]/g) || []).length < 2) return;
        const codigoDoArquivo = candidatoDeArquivo(token);
        const codigo = Docs.corrigirCodigoParaTriagem
          ? Docs.corrigirCodigoParaTriagem(codigoDoArquivo || token)
          : codigoDoArquivo || (Docs.pareceCodigo(token) ? token : "");
        if (!codigo) return;
        const chave = Docs.chave ? Docs.chave(codigo) : codigo.toUpperCase();
        if (!chave || vistos.has(chave)) return;
        vistos.add(chave);
        documentos.push(codigo);
      });
    });
    return documentos;
  }

  function extrairTitulos(linhas) {
    const titulos = [];
    const vistos = new Set();
    linhas.forEach((linha) => {
      const achado = linha.match(/^(?:t[ií]tulo(?:\s+do\s+documento)?|descri[cç][aã]o\s+do\s+documento)\s*(?:\d+\s*)?[:\-]\s*(.+)$/i);
      const titulo = texto(achado && achado[1]);
      if (!titulo || (Docs && Docs.pareceCodigo && Docs.pareceCodigo(titulo))) return;
      const chave = semAcentos(titulo);
      if (vistos.has(chave)) return;
      vistos.add(chave);
      titulos.push(titulo);
    });
    return titulos;
  }

  const REGRAS_TIPO = Object.freeze([
    { codigo: "POSTAGEM_SIGEM", termos: [[/post(?:ar|agem|ado).*sigem|sigem.*post/i, 7], [/post(?:ar|agem)/i, 3], [/sigem/i, 2]] },
    { codigo: "ALTERACAO_TITULO", termos: [[/(?:alter|corrig|ajust).{0,28}t[ií]tulo|t[ií]tulo.{0,28}(?:alter|corrig|ajust)/i, 7]] },
    { codigo: "CORRECAO_ALOCACAO", termos: [[/(?:corre[cç][aã]o|corrig|ajust).{0,28}aloca[cç][aã]o|aloca[cç][aã]o.{0,28}(?:incorret|errad|corrig)/i, 7]] },
    { codigo: "CORRECAO_LD", termos: [[/(?:corre[cç][aã]o|corrig|ajust|alter).{0,24}\bld\b|\bld\b.{0,24}(?:incorret|errad|corrig|ajust)/i, 7]] },
    { codigo: "INCLUSAO_CV", termos: [[/(?:inclu|inser).{0,24}\bcv\b|\bcv\b.{0,24}(?:inclu|inser)/i, 7]] },
    { codigo: "IMPRESSAO", termos: [[/impress[aã]o|imprimir|plota(?:r|gem)/i, 6]] },
    { codigo: "LOCALIZAR_CODIGO", termos: [[/(?:localiz|encontr|descobrir|qual).{0,30}c[oó]digo|c[oó]digo.{0,30}(?:t[ií]tulo|localiz|encontr)/i, 6]] },
    { codigo: "CONSULTA_INFO", termos: [[/solicita[cç][aã]o de informa[cç][aã]o|consulta|d[uú]vida|gostaria de saber|qual (?:o )?status/i, 4]] },
  ]);

  function sugerirTipo(bruto, tipos) {
    const ativos = new Map((tipos || []).filter((tipo) => tipo && tipo.active !== false)
      .map((tipo) => [texto(tipo.code), tipo]));
    const candidatos = [];
    REGRAS_TIPO.forEach((regra) => {
      if (ativos.size && !ativos.has(regra.codigo)) return;
      let pontos = 0;
      regra.termos.forEach(([padrao, valor]) => { if (padrao.test(bruto)) pontos += valor; });
      const tipo = ativos.get(regra.codigo);
      if (tipo && texto(tipo.label) && semAcentos(bruto).includes(semAcentos(tipo.label))) pontos += 8;
      if (pontos) candidatos.push({ codigo: regra.codigo, pontos });
    });
    candidatos.sort((a, b) => b.pontos - a.pontos || a.codigo.localeCompare(b.codigo));
    if (!candidatos.length || candidatos[0].pontos < 4) return { codigo: "", confiavel: false };
    if (candidatos[1] && candidatos[1].pontos === candidatos[0].pontos) return { codigo: "", confiavel: false };
    return {
      codigo: candidatos[0].codigo,
      confiavel: candidatos[0].pontos >= 6 && (!candidatos[1] || candidatos[0].pontos - candidatos[1].pontos >= 2),
    };
  }

  function limparPedido(linhas, cabecalho) {
    const mantidas = [];
    let assinatura = false;
    linhas.forEach((linha, indice) => {
      if (assinatura || cabecalho.removidas.has(indice)) return;
      if (ehCabecalhoDeEmail(linha) || ehLinhaRotulada(linha)) return;
      if (/^(?:atenciosamente|att\.?|cordialmente|grato|obrigad[oa]|best regards)[,!\s]*$/i.test(linha)) {
        assinatura = true;
        return;
      }
      if (/^[-_=]{3,}$/.test(linha)) return;
      mantidas.push(linha);
    });
    const resultado = mantidas.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    return resultado || cabecalho.assunto;
  }

  function analisar(bruto, { tipos = [] } = {}) {
    const original = String(bruto || "").slice(0, 20000);
    const linhas = linhasDe(original);
    const cabecalho = dadosDoCabecalho(linhas);
    const documentos = extrairDocumentos(linhas);
    const titulos = extrairTitulos(linhas);
    const tipo = sugerirTipo(original, tipos);
    return Object.freeze({
      nome: cabecalho.nome,
      contato: cabecalho.contato,
      area: cabecalho.area,
      assunto: cabecalho.assunto,
      pedido: limparPedido(linhas, cabecalho),
      documentos: Object.freeze(documentos),
      titulos: Object.freeze(titulos),
      tipoCodigo: tipo.codigo,
      tipoConfiavel: tipo.confiavel,
      canal: cabecalho.canal,
    });
  }

  root.FlowQuickParse = Object.freeze({ analisar, sugerirTipo, extrairDocumentos });
})(window);
