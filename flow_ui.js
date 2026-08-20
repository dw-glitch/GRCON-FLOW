/**
 * GRCON Flow — peças de interface compartilhadas.
 *
 * Barra do topo, guarda de rota, avisos, formatação e os selos de situação.
 * Ficam num arquivo só porque as três telas precisam responder às mesmas
 * perguntas — quem está logado, o que essa classificação quer dizer, esse
 * prazo já venceu — e responder diferente em cada uma seria um defeito.
 */
(function (root) {
  "use strict";

  const doc = root.document;
  const $ = (seletor, escopo) => (escopo || doc).querySelector(seletor);
  const $$ = (seletor, escopo) => [...(escopo || doc).querySelectorAll(seletor)];

  function texto(valor) {
    return valor === null || valor === undefined ? "" : String(valor).trim();
  }

  /** Escapa antes de qualquer inserção via innerHTML. Nome de arquivo,
   *  título de LD e comentário são texto de usuário e não podem virar marcação. */
  function esc(valor) {
    return texto(valor)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function elemento(tag, atributos = {}, filhos = []) {
    const node = doc.createElement(tag);
    Object.entries(atributos).forEach(([chave, valor]) => {
      if (valor === null || valor === undefined || valor === false) return;
      if (chave === "class") node.className = valor;
      else if (chave === "text") node.textContent = valor;
      else if (chave === "html") node.innerHTML = valor;
      else if (chave.startsWith("on") && typeof valor === "function") {
        node.addEventListener(chave.slice(2).toLowerCase(), valor);
      } else node.setAttribute(chave, valor === true ? "" : String(valor));
    });
    (Array.isArray(filhos) ? filhos : [filhos]).forEach((filho) => {
      if (filho === null || filho === undefined) return;
      node.append(filho instanceof Node ? filho : doc.createTextNode(String(filho)));
    });
    return node;
  }

  // ---------------------------------------------------------------------------
  // Vocabulário da operação
  // ---------------------------------------------------------------------------
  const CLASSIFICACOES = {
    PRONTO: { rotulo: "Pronto", classe: "pronto" },
    VALIDAR: { rotulo: "Validar", classe: "validar" },
    NAO_LOCALIZADO: { rotulo: "Não localizado", classe: "nao-localizado" },
    ACAO_NECESSARIA: { rotulo: "Ação necessária", classe: "acao" },
    IDENTIFICACAO_PENDENTE: { rotulo: "Identificação pendente", classe: "pendente" },
    POSSIVEIS_CORRESPONDENCIAS: { rotulo: "Possíveis correspondências", classe: "candidatos" },
    TRIAGEM_NAO_APLICAVEL: { rotulo: "Triagem não aplicável", classe: "neutro" },
  };

  const STATUS = {
    rascunho: "Rascunho",
    recebido: "Recebido",
    em_triagem: "Em triagem",
    identificacao_pendente: "Identificação pendente",
    aguardando_info: "Aguardando informação",
    pendente: "Pendente",
    em_execucao: "Em execução",
    aguardando_validacao: "Aguardando validação",
    concluido: "Concluído",
    cancelado: "Cancelado",
  };

  const PAPEIS = {
    solicitante: "Solicitante",
    operador: "Operador",
    administrador: "Administrador",
    proprietario: "Proprietário",
  };

  function rotuloStatus(valor) { return STATUS[texto(valor)] || texto(valor) || "—"; }
  function rotuloPapel(valor) { return PAPEIS[texto(valor)] || texto(valor) || "—"; }

  /**
   * Selo da classificação. "Não localizado" tem duas caras: quando o tipo de
   * solicitação é justamente para incluir o documento, não achar é o esperado
   * e não deve gritar em vermelho no painel.
   */
  function seloClassificacao(valor, esperado) {
    const info = CLASSIFICACOES[texto(valor)];
    if (!info) return elemento("span", { class: "flow-selo neutro", text: "—" });
    const classe = valor === "NAO_LOCALIZADO" && esperado ? "nao-localizado-esperado" : info.classe;
    const rotulo = valor === "NAO_LOCALIZADO" && esperado ? "Não consta (esperado)" : info.rotulo;
    return elemento("span", { class: `flow-selo ${classe}`, text: rotulo });
  }

  function seloStatus(valor) {
    const concluido = valor === "concluido";
    const cancelado = valor === "cancelado";
    const classe = concluido ? "pronto" : cancelado ? "neutro" : "candidatos";
    return elemento("span", { class: `flow-selo ${classe}`, text: rotuloStatus(valor) });
  }

  /** Situação do prazo, dita como a operação fala: no prazo, vence hoje, atrasado. */
  function situacaoPrazo(dataLimite, fechado) {
    if (fechado || !dataLimite) return null;
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const limite = new Date(`${texto(dataLimite)}T00:00:00`);
    if (Number.isNaN(limite.getTime())) return null;
    const dias = Math.round((limite - hoje) / 86400000);
    if (dias < 0) {
      const atraso = Math.abs(dias);
      return { classe: "atrasado", rotulo: `Atrasado há ${atraso} dia${atraso > 1 ? "s" : ""}` };
    }
    if (dias === 0) return { classe: "vence-hoje", rotulo: "Vence hoje" };
    return { classe: "no-prazo", rotulo: `No prazo · ${dias}d` };
  }

  function seloPrazo(dataLimite, fechado) {
    const situacao = situacaoPrazo(dataLimite, fechado);
    if (!situacao) return elemento("span", { class: "flow-selo neutro", text: "—" });
    return elemento("span", { class: `flow-selo ${situacao.classe}`, text: situacao.rotulo });
  }

  // ---------------------------------------------------------------------------
  // Formatação
  // ---------------------------------------------------------------------------
  function data(valor) {
    if (!valor) return "—";
    const d = new Date(valor);
    return Number.isNaN(d.getTime()) ? texto(valor) : d.toLocaleDateString("pt-BR");
  }

  function dataHora(valor) {
    if (!valor) return "—";
    const d = new Date(valor);
    return Number.isNaN(d.getTime())
      ? texto(valor)
      : d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function iniciais(nome) {
    const partes = texto(nome).split(/\s+/).filter(Boolean);
    if (!partes.length) return "?";
    return (partes[0][0] + (partes.length > 1 ? partes[partes.length - 1][0] : "")).toUpperCase();
  }

  // ---------------------------------------------------------------------------
  // Avisos
  // ---------------------------------------------------------------------------
  let toastNode = null;
  let toastTimer = null;

  function avisar(mensagem, tipo = "") {
    if (!toastNode) {
      toastNode = elemento("div", { class: "flow-toast", role: "status", "aria-live": "polite" });
      doc.body.append(toastNode);
    }
    toastNode.className = `flow-toast visivel ${tipo}`;
    toastNode.textContent = texto(mensagem);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastNode.className = "flow-toast"; }, tipo === "erro" ? 6000 : 3500);
  }

  function carregando(destino, mensagem = "Carregando…") {
    if (!destino) return;
    destino.replaceChildren(elemento("div", { class: "flow-carregando" }, [
      elemento("span", { class: "flow-spin", "aria-hidden": "true" }),
      mensagem,
    ]));
  }

  function vazio(destino, titulo, detalhe) {
    if (!destino) return;
    destino.replaceChildren(elemento("div", { class: "flow-vazio" }, [
      elemento("strong", { text: titulo }),
      detalhe ? elemento("span", { text: detalhe }) : null,
    ]));
  }

  // ---------------------------------------------------------------------------
  // Barra do topo e guarda de rota
  // ---------------------------------------------------------------------------
  function montarTopo({ ativo = "", subtitulo = "" } = {}) {
    const Api = root.FlowApi;
    const perfil = Api.auth.profile || {};
    const equipe = Api.auth.ehEquipe();

    const links = [
      { href: "/solicitar", rotulo: "Nova solicitação", chave: "solicitar" },
      { href: "/acompanhar", rotulo: "Acompanhar", chave: "acompanhar" },
    ];
    if (equipe) links.push({ href: "/painel", rotulo: "Painel", chave: "painel" });

    const nav = elemento("nav", { "aria-label": "Áreas do GRCON Flow" },
      links.map((link) => elemento("a", {
        href: link.href,
        text: link.rotulo,
        "aria-current": link.chave === ativo ? "page" : null,
      }))
    );

    return elemento("header", { class: "flow-topbar" }, [
      elemento("a", { class: "flow-brand", href: "/", "aria-label": "GRCON Flow — início" }, [
        elemento("img", { src: "grcon-logo-app.png", alt: "GRCON" }),
        elemento("span", {}, [
          elemento("strong", { text: "GRCON Flow" }),
          elemento("span", { text: subtitulo || "Central de solicitações documentais" }),
        ]),
      ]),
      elemento("span", { class: "flow-topbar-spacer" }),
      nav,
      elemento("div", { class: "flow-user" }, [
        elemento("span", { class: "flow-user-chip", "aria-hidden": "true", text: iniciais(perfil.full_name || perfil.email) }),
        elemento("span", { class: "flow-user-info" }, [
          elemento("strong", { text: texto(perfil.full_name) || texto(perfil.email) || "Usuário" }),
          elemento("span", { text: rotuloPapel(perfil.role) }),
        ]),
        elemento("button", {
          class: "text-button", type: "button", text: "Sair",
          onclick: async () => { await Api.auth.sair(); root.location.href = "/"; },
        }),
      ]),
    ]);
  }

  function montarRodape() {
    return elemento("footer", { class: "flow-footer" }, [
      elemento("span", { text: "GRCON Flow · central de solicitações documentais" }),
      elemento("span", { text: "Processamento no servidor · acesso por perfil · histórico completo" }),
    ]);
  }

  /**
   * Guarda de rota. Devolve o perfil quando a pessoa pode ficar na página; caso
   * contrário manda para onde ela pode ir e devolve null — a tela nem chega a
   * montar. A permissão real é a do banco; isto aqui é a cortesia de não
   * mostrar uma tela que só produziria erro.
   */
  async function exigirSessao({ equipe = false, admin = false } = {}) {
    const Api = root.FlowApi;
    await Api.auth.iniciar();
    if (!Api.auth.session) {
      const destino = encodeURIComponent(root.location.pathname + root.location.search);
      root.location.replace(`/?destino=${destino}`);
      return null;
    }
    if (admin && !Api.auth.ehAdmin()) {
      avisar("Esta área é restrita a administradores.", "erro");
      root.location.replace("/solicitar");
      return null;
    }
    if (equipe && !Api.auth.ehEquipe()) {
      avisar("Esta área é restrita à equipe de operação.", "erro");
      root.location.replace("/solicitar");
      return null;
    }
    return Api.auth.profile;
  }

  /** Confirmação simples, para ações que apagam ou publicam algo. */
  function confirmar(mensagem) {
    return root.confirm(mensagem);
  }

  root.FlowUi = Object.freeze({
    $, $$, elemento, esc, texto,
    CLASSIFICACOES, STATUS, PAPEIS,
    rotuloStatus, rotuloPapel, seloClassificacao, seloStatus, seloPrazo, situacaoPrazo,
    data, dataHora, iniciais,
    avisar, carregando, vazio, confirmar,
    montarTopo, montarRodape, exigirSessao,
  });
})(window);
