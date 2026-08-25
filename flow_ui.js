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

  const ICONES_NAVEGACAO = Object.freeze({
    painel: "M4 13h6V4H4v9Zm10 7h6v-9h-6v9ZM4 20h6v-3H4v3Zm10-13h6V4h-6v3Z",
    solicitar: "M12 5v14M5 12h14",
    acompanhar: "M4 12a8 8 0 1 0 3-6.25M4 4v5h5M12 8v5l3 2",
  });

  function iconeNavegacao(chave) {
    return elemento("svg", {
      class: "flow-nav-icon", viewBox: "0 0 24 24", "aria-hidden": "true",
      html: `<path d="${ICONES_NAVEGACAO[chave] || ICONES_NAVEGACAO.painel}"></path>`,
    });
  }

  // ---------------------------------------------------------------------------
  // Vocabulário da operação
  // ---------------------------------------------------------------------------
  // O rótulo responde primeiro à pergunta operacional mais importante — este
  // documento é novo ou já existe na LD? — e só depois ao detalhe. Quem lê o
  // painel decide a próxima ação sem abrir o item.
  const CLASSIFICACOES = Object.freeze({
    PRONTO: Object.freeze({ rotulo: "JÁ EXISTE · alocado", classe: "pronto" }),
    VALIDAR: Object.freeze({ rotulo: "JÁ EXISTE · validar divergência", classe: "validar" }),
    NAO_LOCALIZADO: Object.freeze({ rotulo: "NOVO · não consta nas LDs", classe: "nao-localizado" }),
    ACAO_NECESSARIA: Object.freeze({ rotulo: "JÁ EXISTE · sem alocação", classe: "acao" }),
    IDENTIFICACAO_PENDENTE: Object.freeze({ rotulo: "PENDENTE · identificar código", classe: "pendente" }),
    POSSIVEIS_CORRESPONDENCIAS: Object.freeze({ rotulo: "POSSÍVEL EXISTENTE · confirmar", classe: "candidatos" }),
    TRIAGEM_NAO_APLICAVEL: Object.freeze({ rotulo: "Triagem não aplicável", classe: "neutro" }),
  });

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

  /**
   * Urgência. "Normal" não ganha selo de propósito: se toda linha carrega um
   * selo, nenhuma chama atenção, e urgente vira decoração. O que se destaca é o
   * que sai do normal.
   */
  const PRIORIDADES = Object.freeze({
    baixa:   Object.freeze({ rotulo: "Baixa",   classe: "prioridade-baixa",   destaque: false }),
    normal:  Object.freeze({ rotulo: "Normal",  classe: "",                   destaque: false }),
    alta:    Object.freeze({ rotulo: "Alta",    classe: "prioridade-alta",    destaque: true }),
    urgente: Object.freeze({ rotulo: "Urgente", classe: "prioridade-urgente", destaque: true }),
  });

  const PRIORIDADE_PADRAO = "normal";

  function rotuloPrioridade(valor) {
    const info = PRIORIDADES[texto(valor)];
    return info ? info.rotulo : texto(valor) || "—";
  }

  /** Verdadeiro só para o que precisa saltar aos olhos: alta e urgente. */
  function prioridadeEmDestaque(valor) {
    const info = PRIORIDADES[texto(valor)];
    return Boolean(info && info.destaque);
  }

  /** Devolve null quando a prioridade é a normal — nada a mostrar. */
  function seloPrioridade(valor) {
    const chave = texto(valor);
    const info = PRIORIDADES[chave];
    if (!info || chave === PRIORIDADE_PADRAO || !info.classe) return null;
    return elemento("span", { class: `flow-selo ${info.classe}`, text: info.rotulo });
  }

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

  /**
   * O que a LD diz sobre a alocação deste item — e são três respostas, não duas.
   *
   * A LD pode trazer o código da alocação; pode afirmar que o documento está
   * alocado sem informar o código (379 linhas das LDs vigentes estão assim); ou
   * pode não alocar. A triagem já distingue os três casos — por isso o resumo
   * dela diz "com alocação (confirmada)" quando o código falta. Eram as telas
   * que colapsavam os dois últimos num "sem alocação identificada" que
   * contradiz a própria LD, ou num "—" que joga a informação fora.
   *
   * A comparação é exata de propósito: "NÃO ALOCADO" contém "ALOCADO", e um
   * teste por substring inverteria justamente o caso que importa.
   */
  function situacaoAlocacao(item) {
    const codigo = texto(item && item.allocation);
    if (codigo) return { estado: "identificada", codigo, rotulo: codigo };
    // Tipo que não consulta LD não tem alocação para ter ou deixar de ter.
    // Dizer "sem alocação identificada" aqui afirmaria que procuramos.
    if (texto(item && item.classification) === "TRIAGEM_NAO_APLICAVEL") {
      return { estado: "nao-aplicavel", codigo: "", rotulo: "—" };
    }
    const status = texto(item && item.allocation_status).toUpperCase().replace(/\s+/g, " ");
    if (status === "ALOCADO" || status === "ALLOCATED") {
      return { estado: "confirmada", codigo: "", rotulo: "Alocada · código não informado na LD" };
    }
    return { estado: "ausente", codigo: "", rotulo: "Sem alocação identificada" };
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

    // A ordem comunica de quem é a tela: o primeiro link é onde aquela pessoa
    // trabalha. A equipe abre no painel; quem solicita, no formulário.
    const links = [
      { href: "/solicitar", rotulo: "Nova solicitação", chave: "solicitar" },
      { href: "/acompanhar", rotulo: "Acompanhar", chave: "acompanhar" },
    ];
    if (equipe) links.unshift({ href: "/painel", rotulo: "Painel", chave: "painel" });

    const nav = elemento("nav", { "aria-label": "Áreas do GRCON Flow" },
      links.map((link) => elemento("a", {
        href: link.href,
        "aria-current": link.chave === ativo ? "page" : null,
      }, [iconeNavegacao(link.chave), elemento("span", { text: link.rotulo })]))
    );

    return elemento("header", { class: "flow-topbar" }, [
      elemento("a", { class: "flow-brand", href: "/", "aria-label": "GRCON Flow — início" }, [
        elemento("img", { src: "grcon-logo-app.png", alt: "GRCON" }),
        elemento("strong", { class: "flow-product", text: "FLOW" }),
        subtitulo ? elemento("span", { class: "sr-only", text: subtitulo }) : null,
      ]),
      elemento("span", { class: "flow-topbar-spacer" }),
      nav,
      elemento("div", { class: "flow-user" }, [
        elemento("button", {
          class: "flow-user-botao", type: "button", title: "Meu perfil",
          "aria-label": `Meu perfil — ${texto(perfil.full_name) || texto(perfil.email) || "usuário"}`,
          onclick: abrirPerfil,
        }, [
          elemento("span", { class: "flow-user-chip", "aria-hidden": "true", text: iniciais(perfil.full_name || perfil.email) }),
          elemento("span", { class: "flow-user-info" }, [
            elemento("strong", { text: texto(perfil.full_name) || texto(perfil.email) || "Usuário" }),
            elemento("span", { text: rotuloPapel(perfil.role) }),
          ]),
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
      elemento("span", { text: "GRCON Flow" }),
      elemento("span", { text: `© ${new Date().getFullYear()} CONSAG Engenharia` }),
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
    // O aviso viaja por query: mostrado na página que está sendo abandonada,
    // ele desapareceria junto com ela e a pessoa não saberia por que voltou.
    const recusar = (motivo) => {
      root.location.replace(`/solicitar?aviso=${encodeURIComponent(motivo)}`);
      return null;
    };
    if (admin && !Api.auth.ehAdmin()) return recusar("Esta área é restrita a administradores.");
    if (equipe && !Api.auth.ehEquipe()) return recusar("Esta área é restrita à equipe de operação.");
    return Api.auth.profile;
  }

  /** Mostra o aviso que veio de um redirecionamento e limpa a URL. */
  function avisoDaUrl() {
    const parametros = new URLSearchParams(root.location.search);
    const aviso = parametros.get("aviso");
    if (!aviso) return;
    avisar(aviso, "erro");
    parametros.delete("aviso");
    const busca = parametros.toString();
    root.history.replaceState({}, "", root.location.pathname + (busca ? `?${busca}` : ""));
  }

  /**
   * Confirmação de uma ação que apaga ou publica algo.
   *
   * Devolve uma **promessa**: a caixa é da aplicação, não do navegador, e a
   * resposta chega depois. Todo chamador precisa `await` — sem ele, o valor
   * testado seria a promessa, sempre verdadeira, e a ação seguiria sem
   * confirmação nenhuma.
   *
   * `exigirTexto` pede que a pessoa digite algo exato (o protocolo, por
   * exemplo) antes de liberar o botão. Substitui o par prompt+confirm nativo,
   * que perguntava duas vezes e ainda assim não conseguia dizer, na segunda,
   * o que estava sendo apagado.
   */
  function confirmar(mensagem, opcoes = {}) {
    const {
      titulo = "Confirmar",
      rotuloConfirmar = "Confirmar",
      rotuloCancelar = "Cancelar",
      perigo = false,
      exigirTexto = "",
      ajuda = "",
    } = opcoes;

    return new Promise((resolver) => {
      let respondido = false;
      const responder = (valor) => {
        if (respondido) return;
        respondido = true;
        resolver(valor);
      };

      const alvo = texto(exigirTexto);
      const entrada = alvo
        ? elemento("input", {
          id: "flow-confirmar-texto", type: "text", autocomplete: "off",
          autocapitalize: "characters", spellcheck: "false",
        })
        : null;

      const botaoConfirmar = elemento("button", {
        class: perigo ? "danger-button" : "primary-button", type: "button",
        text: rotuloConfirmar, disabled: alvo ? true : null,
      });

      if (entrada) {
        const conferir = () => {
          botaoConfirmar.disabled = texto(entrada.value).toUpperCase() !== alvo.toUpperCase();
        };
        entrada.addEventListener("input", conferir);
        entrada.addEventListener("keydown", (evento) => {
          if (evento.key !== "Enter") return;
          evento.preventDefault();
          if (!botaoConfirmar.disabled) botaoConfirmar.click();
        });
      }

      const controle = abrirModal({
        titulo,
        aoFechar: () => responder(false),
        montarCorpo: () => [
          elemento("p", { style: "margin:0;white-space:pre-wrap", text: texto(mensagem) }),
          entrada ? elemento("label", { class: "flow-campo", for: "flow-confirmar-texto" }, [
            elemento("span", { text: `Digite ${alvo} para confirmar` }),
            entrada,
          ]) : null,
          ajuda ? elemento("p", { style: "margin:0;font-size:.78rem;color:var(--text-3)", text: ajuda }) : null,
        ],
        montarAcoes: (fechar) => {
          botaoConfirmar.addEventListener("click", () => { responder(true); fechar(); });
          return [
            elemento("button", {
              class: "secondary-button", type: "button", text: rotuloCancelar,
              onclick: () => { responder(false); fechar(); },
            }),
            botaoConfirmar,
          ];
        },
      });

      // Sem campo para digitar, o foco começa em "Cancelar": numa caixa que
      // pergunta se pode apagar, a tecla Enter não deve apagar.
      if (!entrada) {
        const cancelar = $(".flow-modal-acoes .secondary-button", controle.painel);
        if (cancelar) cancelar.focus();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Caixa modal
  //
  // Para formulários curtos que não valem uma troca de tela. Devolve o foco de
  // onde veio e prende o Tab dentro do diálogo: quem navega por teclado não
  // pode ser largado numa página que continua visível atrás da caixa.
  // ---------------------------------------------------------------------------
  function abrirModal({ titulo, descricao = "", montarCorpo, montarAcoes = null, aoFechar = null } = {}) {
    const anterior = doc.activeElement;
    const fundo = elemento("div", { class: "flow-modal" });
    const painel = elemento("div", {
      class: "flow-modal-painel", role: "dialog", "aria-modal": "true", "aria-label": texto(titulo),
    });

    function focaveis() {
      return $$("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])", painel)
        .filter((node) => !node.hidden && node.offsetParent !== null);
    }

    function aoTeclar(evento) {
      if (evento.key === "Escape") {
        evento.preventDefault();
        // O Escape morre aqui. A tela por trás também escuta Escape — a ficha
        // do painel, a caixa de notificações — e sem esta parada um Escape só
        // fecharia a pergunta e o que estava sendo perguntado, junto.
        evento.stopPropagation();
        fechar();
        return;
      }
      if (evento.key !== "Tab") return;
      const lista = focaveis();
      if (!lista.length) return;
      const primeiro = lista[0];
      const ultimo = lista[lista.length - 1];
      if (evento.shiftKey && doc.activeElement === primeiro) { evento.preventDefault(); ultimo.focus(); }
      else if (!evento.shiftKey && doc.activeElement === ultimo) { evento.preventDefault(); primeiro.focus(); }
    }

    function fechar() {
      doc.removeEventListener("keydown", aoTeclar, true);
      fundo.remove();
      doc.body.classList.remove("p1-modal-open");
      if (anterior && typeof anterior.focus === "function") anterior.focus();
      // Sair pelo Escape, pelo fundo ou pelo X é uma resposta como outra
      // qualquer: quem espera por ela precisa ser avisado dos três jeitos.
      if (typeof aoFechar === "function") aoFechar();
    }

    // `append` converte null no texto "null"; só `elemento` filtra por conta
    // própria. Aqui a lista é montada antes e limpa na mão.
    painel.append(...[
      elemento("div", { class: "flow-modal-head" }, [
        elemento("div", { style: "flex:1;min-width:0" }, [
          elemento("h2", { text: texto(titulo) }),
          descricao ? elemento("p", { text: descricao }) : null,
        ]),
        elemento("button", { class: "text-button", type: "button", text: "Fechar", onclick: fechar }),
      ]),
      elemento("div", { class: "flow-modal-corpo" }, montarCorpo ? montarCorpo(fechar) : []),
      montarAcoes ? elemento("div", { class: "flow-modal-acoes" }, montarAcoes(fechar)) : null,
    ].filter(Boolean));

    fundo.append(painel);
    fundo.addEventListener("click", (evento) => { if (evento.target === fundo) fechar(); });
    doc.addEventListener("keydown", aoTeclar, true);
    doc.body.append(fundo);
    doc.body.classList.add("p1-modal-open");
    const inicial = focaveis().find((node) => node.tagName !== "BUTTON") || focaveis()[0];
    if (inicial) inicial.focus();
    return { fechar, painel };
  }

  // ---------------------------------------------------------------------------
  // Meu perfil
  //
  // O formulário de solicitação já vinha preenchido com o nome do perfil, mas
  // não havia onde corrigi-lo: quem entrou com o nome errado o reescrevia a cada
  // pedido. A troca de senha mora aqui pelo mesmo motivo — quem lembra da senha
  // atual não deveria precisar do fluxo de "esqueci".
  // ---------------------------------------------------------------------------
  /** Sincroniza a barra do topo com o perfil recém-salvo. */
  function atualizarTopoComPerfil() {
    const perfil = (root.FlowApi.auth.profile) || {};
    const nome = texto(perfil.full_name) || texto(perfil.email) || "Usuário";
    const chip = $(".flow-user-botao .flow-user-chip");
    if (chip) chip.textContent = iniciais(perfil.full_name || perfil.email);
    const rotulo = $(".flow-user-botao .flow-user-info strong");
    if (rotulo) rotulo.textContent = nome;
    const botao = $(".flow-user-botao");
    if (botao) botao.setAttribute("aria-label", `Meu perfil — ${nome}`);
  }

  function abrirPerfil() {
    const Api = root.FlowApi;
    const perfil = Api.auth.profile || {};

    const campo = (id, rotulo, valor, { tipo = "text", ajuda = "", autocomplete = "off" } = {}) => {
      const entrada = elemento("input", { id, type: tipo, autocomplete });
      entrada.value = texto(valor);
      return {
        entrada,
        node: elemento("label", { class: "flow-campo", for: id }, [
          elemento("span", { text: rotulo }),
          ajuda ? elemento("small", { text: ajuda }) : null,
          entrada,
        ]),
      };
    };

    const nome = campo("perfil-nome", "Nome completo", perfil.full_name, { autocomplete: "name" });
    const area = campo("perfil-area", "Área / setor", perfil.area);
    const contato = campo("perfil-contato", "Contato", perfil.contact || perfil.email, {
      ajuda: "E-mail ou ramal usado para retorno das solicitações.",
    });
    const senha = campo("perfil-senha", "Nova senha", "", { tipo: "password", autocomplete: "new-password", ajuda: "Mínimo de 6 caracteres. Deixe vazio para não trocar." });

    const salvarDados = elemento("button", { class: "primary-button", type: "button", text: "Salvar dados" });
    const salvarSenha = elemento("button", { class: "secondary-button", type: "button", text: "Trocar senha" });

    salvarDados.addEventListener("click", async () => {
      if (!texto(nome.entrada.value)) { avisar("Informe seu nome.", "erro"); nome.entrada.focus(); return; }
      salvarDados.disabled = true;
      salvarDados.textContent = "Salvando…";
      const { error } = await Api.auth.atualizarPerfil({
        full_name: nome.entrada.value, area: area.entrada.value, contact: contato.entrada.value,
      });
      salvarDados.disabled = false;
      salvarDados.textContent = "Salvar dados";
      if (error) { avisar(error, "erro"); return; }
      avisar("Perfil atualizado.", "ok");
      // A barra do topo mostra nome e iniciais: atualizamos no lugar em vez de
      // recarregar a página, que jogaria fora um pedido em preenchimento.
      atualizarTopoComPerfil();
    });

    salvarSenha.addEventListener("click", async () => {
      const nova = senha.entrada.value;
      if (nova.length < 6) { avisar("A senha precisa ter pelo menos 6 caracteres.", "erro"); senha.entrada.focus(); return; }
      salvarSenha.disabled = true;
      salvarSenha.textContent = "Trocando…";
      const { error } = await Api.auth.definirSenha(nova);
      salvarSenha.disabled = false;
      salvarSenha.textContent = "Trocar senha";
      if (error) { avisar(error, "erro"); return; }
      senha.entrada.value = "";
      avisar("Senha alterada.", "ok");
    });

    return abrirModal({
      titulo: "Meu perfil",
      descricao: `${texto(perfil.email) || "—"} · ${rotuloPapel(perfil.role)}`,
      montarCorpo: () => [
        elemento("div", { class: "flow-grid" }, [nome.node, area.node, contato.node]),
        elemento("div", { class: "flow-acoes" }, [salvarDados]),
        elemento("hr", { style: "border:none;border-top:1px solid var(--border-1);margin:.4rem 0" }),
        elemento("div", { class: "flow-grid" }, [senha.node]),
        elemento("div", { class: "flow-acoes" }, [salvarSenha]),
        elemento("p", { style: "margin:0;font-size:.76rem;color:var(--text-3)", text:
          "O e-mail e o papel não são editáveis aqui: o e-mail identifica a conta e o papel é atribuído em Painel → Usuários." }),
      ],
    });
  }

  root.FlowUi = Object.freeze({
    $, $$, elemento, esc, texto,
    CLASSIFICACOES, STATUS, PAPEIS, PRIORIDADES, PRIORIDADE_PADRAO,
    rotuloStatus, rotuloPapel, seloClassificacao, seloStatus, seloPrazo, situacaoPrazo,
    situacaoAlocacao, rotuloPrioridade, seloPrioridade, prioridadeEmDestaque,
    data, dataHora, iniciais,
    avisar, carregando, vazio, confirmar, avisoDaUrl, abrirModal, abrirPerfil,
    montarTopo, montarRodape, exigirSessao,
  });
})(window);
