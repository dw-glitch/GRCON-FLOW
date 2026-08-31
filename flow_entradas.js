/**
 * GRCON Flow — entradas externas.
 *
 * A ponte instalada no Windows lê a pasta `GRCON Flow` do Outlook clássico e
 * entrega as mensagens aqui. Esta tela é deliberadamente uma fila de revisão,
 * não uma caixa de e-mail: nada do que chega vira solicitação sozinho. O
 * protocolo nasce apenas quando alguém da Qualidade lê, corrige o que faltou e
 * clica em registrar — e é o banco, não esta tela, que garante que a mesma
 * mensagem não gere dois protocolos.
 */
(function (root) {
  "use strict";

  const Ui = root.FlowUi;
  const { elemento, avisar, texto } = Ui;
  const Api = root.FlowApi;

  const SELOS = Object.freeze({
    novo: { rotulo: "Nova", classe: "nova" },
    em_revisao: { rotulo: "Em revisão", classe: "revisao" },
    convertido: { rotulo: "Convertida", classe: "convertida" },
    descartado: { rotulo: "Descartada", classe: "descartada" },
    erro: { rotulo: "Com erro", classe: "erro" },
  });

  const estado = {
    status: "novo",
    busca: "",
    pagina: 1,
    total: 0,
    itens: [],
  };

  let destinoAtual = null;
  let tiposAtuais = [];
  let aoConverterAtual = null;
  let aoMudarAtual = null;
  let encerrarObservacao = null;
  let recargaAgendada = null;

  function selo(status) {
    const definicao = SELOS[status] || SELOS.novo;
    return elemento("span", {
      class: `flow-entrada-selo ${definicao.classe}`, text: definicao.rotulo,
    });
  }

  function totalDePaginas() {
    const porPagina = Api.entradasExternas.porPagina || 25;
    return Math.max(1, Math.ceil(estado.total / porPagina));
  }

  /**
   * O realtime avisa por mensagem; um lote de cem chega como cem avisos. Um
   * intervalo curto transforma a rajada em uma única releitura.
   */
  function agendarRecarga() {
    if (recargaAgendada) return;
    recargaAgendada = root.setTimeout(() => {
      recargaAgendada = null;
      if (destinoAtual && destinoAtual.isConnected) carregar();
    }, 1200);
  }

  function trecho(entrada) {
    if (entrada.body_redacted_at) {
      return "Texto removido pela retenção de 90 dias. Assunto, remetente e rastreabilidade continuam.";
    }
    const corpo = texto(entrada.body_text);
    if (!corpo) return "Mensagem sem texto.";
    return corpo.length > 240 ? `${corpo.slice(0, 240)}…` : corpo;
  }

  function dado(rotulo, valor) {
    return elemento("div", { class: "flow-dado" }, [
      elemento("dt", { text: rotulo }),
      elemento("dd", { text: valor || "—" }),
    ]);
  }

  async function revisar(entrada) {
    if (!root.FlowRegistroRapido) {
      avisar("O registro rápido não está disponível nesta tela.", "erro");
      return;
    }
    root.FlowRegistroRapido.abrir({
      tipos: tiposAtuais,
      entrada,
      aoRegistrar: async (solicitacao) => {
        await carregar();
        if (typeof aoConverterAtual === "function") await aoConverterAtual(solicitacao);
      },
    });
  }

  async function descartar(entrada) {
    const confirmou = await Ui.confirmar(
      `Descartar a mensagem de ${entrada.sender_email}?`,
      {
        titulo: "Descartar entrada",
        rotuloConfirmar: "Descartar",
        perigo: true,
        ajuda: "O e-mail original continua no Outlook. Nada é apagado lá; aqui fica o registro de quem descartou.",
      }
    );
    if (!confirmou) return;
    const { error } = await Api.entradasExternas.descartar(entrada.id, "Descartada na revisão da Qualidade.");
    if (error) { avisar(error, "erro"); return; }
    avisar("Entrada descartada.", "ok");
    await carregar();
  }

  function cartao(entrada) {
    const pendente = entrada.status === "novo" || entrada.status === "em_revisao";
    const protocolo = entrada.solicitacao && entrada.solicitacao.protocol;
    const anexos = Number(entrada.attachment_count) || 0;
    const acoes = [];
    if (pendente) {
      acoes.push(elemento("button", {
        class: "primary-button compact", type: "button", text: "Revisar e registrar",
        onclick: () => revisar(entrada),
      }));
      acoes.push(elemento("button", {
        class: "text-button danger", type: "button", text: "Descartar",
        onclick: () => descartar(entrada),
      }));
    }
    if (protocolo && entrada.request_id) {
      acoes.push(elemento("button", {
        class: "text-button", type: "button", text: `Abrir ${protocolo}`,
        onclick: () => {
          if (typeof aoConverterAtual === "function") {
            aoConverterAtual({ id: entrada.request_id, protocol: protocolo });
          }
        },
      }));
    }

    return elemento("article", { class: "flow-entrada" }, [
      elemento("header", { class: "flow-entrada-head" }, [
        elemento("div", {}, [
          elemento("strong", { text: texto(entrada.subject) || "(sem assunto)" }),
          elemento("p", {
            class: "flow-entrada-remetente",
            text: texto(entrada.sender_name)
              ? `${entrada.sender_name} · ${entrada.sender_email}`
              : texto(entrada.sender_email),
          }),
        ]),
        selo(entrada.status),
      ]),
      elemento("p", { class: "flow-entrada-trecho", text: trecho(entrada) }),
      elemento("dl", { class: "flow-dados" }, [
        dado("Recebida", Ui.dataHora(entrada.received_at)),
        dado("Importada por", texto(entrada.submitted_by_email)),
        dado("Anexos", anexos ? `${anexos} no Outlook` : "Nenhum"),
        entrada.status === "descartado" && texto(entrada.discarded_reason)
          ? dado("Motivo", entrada.discarded_reason)
          : null,
      ]),
      // Sem Microsoft Graph o painel não abre a mensagem original. Dizer onde
      // ela está é mais honesto do que oferecer um link que não funcionaria.
      anexos ? elemento("p", {
        class: "flow-entrada-nota",
        text: "Os arquivos originais continuam no Outlook, em GRCON Flow → Processados.",
      }) : null,
      acoes.length ? elemento("div", { class: "flow-acoes" }, acoes) : null,
    ]);
  }

  function montarFiltros() {
    const busca = elemento("input", {
      id: "entradas-busca", type: "search", value: estado.busca,
      placeholder: "Assunto, nome ou e-mail do remetente", autocomplete: "off",
    });
    busca.addEventListener("change", () => {
      estado.busca = texto(busca.value);
      estado.pagina = 1;
      carregar();
    });

    const situacoes = elemento("div", { class: "flow-abas", role: "tablist" },
      Api.entradasExternas.situacoes.map((situacao) => elemento("button", {
        class: "flow-aba", type: "button", role: "tab",
        "aria-selected": estado.status === situacao.valor ? "true" : "false",
        text: situacao.rotulo,
        onclick: () => {
          if (estado.status === situacao.valor) return;
          estado.status = situacao.valor;
          estado.pagina = 1;
          carregar();
        },
      })));

    return elemento("div", { class: "flow-filtros flow-entradas-filtros" }, [
      situacoes,
      elemento("label", { class: "flow-campo", for: "entradas-busca" }, [
        elemento("span", { text: "Buscar" }),
        busca,
      ]),
      elemento("button", {
        class: "secondary-button compact", type: "button", text: "Atualizar",
        onclick: () => carregar(),
      }),
    ]);
  }

  function montarPaginacao() {
    const paginas = totalDePaginas();
    if (paginas <= 1) return null;
    return elemento("div", { class: "flow-entradas-paginacao" }, [
      elemento("button", {
        class: "secondary-button compact", type: "button", text: "Anterior",
        disabled: estado.pagina <= 1,
        onclick: () => { estado.pagina -= 1; carregar(); },
      }),
      elemento("span", { text: `Página ${estado.pagina} de ${paginas} · ${estado.total} entrada(s)` }),
      elemento("button", {
        class: "secondary-button compact", type: "button", text: "Próxima",
        disabled: estado.pagina >= paginas,
        onclick: () => { estado.pagina += 1; carregar(); },
      }),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Pontes locais
  // ---------------------------------------------------------------------------

  /**
   * O instalador imprime um código de pareamento em JSON. Ele contém apenas o
   * identificador, o e-mail vinculado, um rótulo e a verificação do segredo —
   * nunca o segredo em si, que fica criptografado no Windows. Por isso pode ser
   * colado aqui sem risco.
   */
  function lerCodigoDePareamento(bruto) {
    const conteudo = texto(bruto);
    if (!conteudo) return { erro: "Cole o código de pareamento gerado pelo instalador." };
    let dados;
    try {
      dados = JSON.parse(conteudo);
    } catch {
      return { erro: "O código colado não é o texto completo gerado pelo instalador." };
    }
    if (!dados || typeof dados !== "object") return { erro: "Código de pareamento inválido." };
    if (dados.secret || dados.segredo) {
      return { erro: "Esse texto contém o segredo da ponte. Cole apenas o código de pareamento." };
    }
    return {
      bridgeId: texto(dados.bridge_id || dados.bridgeId),
      hash: texto(dados.secret_hash || dados.hash),
      email: texto(dados.submitted_by_email || dados.email),
      rotulo: texto(dados.label || dados.rotulo),
    };
  }

  async function ativarPonte(campo, status) {
    const lido = lerCodigoDePareamento(campo.value);
    if (lido.erro) {
      status.className = "flow-registro-rapido-progresso erro";
      status.textContent = lido.erro;
      return;
    }
    status.className = "flow-registro-rapido-progresso";
    status.textContent = "Ativando a ponte…";
    const { error } = await Api.pontesOutlook.registrar(lido);
    if (error) {
      status.className = "flow-registro-rapido-progresso erro";
      status.textContent = error;
      return;
    }
    campo.value = "";
    status.className = "flow-registro-rapido-progresso ok";
    status.textContent = "Ponte ativada. Ela aparece abaixo assim que enviar o primeiro lote.";
    await desenharPontes();
  }

  async function revogarPonte(ponte) {
    const confirmou = await Ui.confirmar(`Revogar a ponte “${ponte.label}”?`, {
      titulo: "Revogar ponte",
      rotuloConfirmar: "Revogar",
      perigo: true,
      ajuda: "Aquele computador para de enviar imediatamente. As entradas já recebidas permanecem.",
    });
    if (!confirmou) return;
    const { error } = await Api.pontesOutlook.revogar(ponte.bridge_id);
    if (error) { avisar(error, "erro"); return; }
    avisar("Ponte revogada.", "ok");
    await desenharPontes();
  }

  function linhaDaPonte(ponte) {
    return elemento("div", { class: `flow-ponte${ponte.active ? "" : " revogada"}` }, [
      elemento("div", {}, [
        elemento("strong", { text: texto(ponte.label) || "Ponte sem rótulo" }),
        elemento("p", { class: "flow-entrada-remetente", text: texto(ponte.submitted_by_email) }),
      ]),
      elemento("dl", { class: "flow-dados" }, [
        dado("Situação", ponte.active ? "Ativa" : "Revogada"),
        dado("Última sincronização", ponte.last_used_at ? Ui.dataHora(ponte.last_used_at) : "Ainda não sincronizou"),
        dado("Último resultado", texto(ponte.last_result) || "—"),
        texto(ponte.last_error) ? dado("Última falha", ponte.last_error) : null,
      ]),
      ponte.active ? elemento("div", { class: "flow-acoes" }, [
        elemento("button", {
          class: "text-button danger", type: "button", text: "Revogar",
          onclick: () => revogarPonte(ponte),
        }),
      ]) : null,
    ]);
  }

  async function desenharPontes() {
    const destino = document.getElementById("entradas-pontes-lista");
    if (!destino) return;
    destino.replaceChildren(elemento("p", { class: "flow-entrada-nota", text: "Carregando pontes…" }));
    const { data, error } = await Api.pontesOutlook.listar();
    if (!destino.isConnected) return;
    if (error) {
      destino.replaceChildren(elemento("p", { class: "flow-registro-rapido-progresso erro", text: error }));
      return;
    }
    if (!data.length) {
      destino.replaceChildren(elemento("p", {
        class: "flow-entrada-nota",
        text: "Nenhum computador conectado. Instale a ponte no Windows e cole aqui o código de pareamento.",
      }));
      return;
    }
    destino.replaceChildren(...data.map(linhaDaPonte));
  }

  function montarPontes() {
    const campo = elemento("textarea", {
      id: "entradas-pareamento", rows: "4", maxlength: "2000",
      placeholder: '{"bridge_id":"…","secret_hash":"…","submitted_by_email":"…","label":"…"}',
    });
    const status = elemento("p", {
      class: "flow-registro-rapido-progresso", role: "status", "aria-live": "polite",
    });
    return elemento("section", { class: "flow-card" }, [
      elemento("div", { class: "flow-card-head" }, [
        elemento("strong", { text: "Computadores conectados" }),
      ]),
      elemento("p", { class: "flow-entrada-nota", text:
        "Cada computador tem a própria credencial. O segredo fica criptografado no Windows; aqui só chega a verificação dele." }),
      elemento("div", { id: "entradas-pontes-lista", class: "flow-pontes" }),
      elemento("label", { class: "flow-campo", for: "entradas-pareamento" }, [
        elemento("span", { text: "Código de pareamento" }),
        campo,
      ]),
      status,
      elemento("div", { class: "flow-acoes" }, [
        elemento("button", {
          class: "primary-button compact", type: "button", text: "Ativar ponte",
          onclick: () => ativarPonte(campo, status),
        }),
      ]),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Montagem
  // ---------------------------------------------------------------------------

  async function carregar() {
    const lista = document.getElementById("entradas-lista");
    if (!lista) return;
    Ui.carregando(lista, "Carregando entradas…");
    const { data, total, error } = await Api.entradasExternas.listar({
      status: estado.status,
      busca: estado.busca,
      pagina: estado.pagina,
    });
    if (!lista.isConnected) return;
    if (error) {
      Ui.vazio(lista, "Não foi possível carregar", error);
      return;
    }
    estado.itens = data;
    estado.total = total;
    // Uma página pode ficar para trás depois de converter os últimos itens.
    if (!data.length && estado.pagina > 1) {
      estado.pagina = 1;
      await carregar();
      return;
    }
    if (!data.length) {
      Ui.vazio(
        lista,
        "Nada por aqui",
        estado.status === "novo"
          ? "Arraste e-mails para a pasta GRCON Flow no Outlook: eles aparecem em cerca de um minuto."
          : "Nenhuma entrada nesta situação."
      );
    } else {
      lista.replaceChildren(...data.map(cartao));
    }
    const rodape = document.getElementById("entradas-paginacao");
    if (rodape) rodape.replaceChildren(...[montarPaginacao()].filter(Boolean));
    if (typeof aoMudarAtual === "function") aoMudarAtual();
    const filtros = document.getElementById("entradas-filtros");
    if (filtros) {
      const rotulos = Api.entradasExternas.situacoes;
      filtros.querySelectorAll("[role=\"tab\"]").forEach((botao, indice) => {
        const situacao = rotulos[indice];
        botao.setAttribute("aria-selected", situacao && situacao.valor === estado.status ? "true" : "false");
      });
    }
  }

  function montar(destino, { tipos = [], aoConverter = null, aoMudar = null } = {}) {
    desmontar();
    destinoAtual = destino;
    tiposAtuais = (tipos || []).filter((tipo) => tipo.active !== false);
    aoConverterAtual = aoConverter;
    aoMudarAtual = aoMudar;

    const blocos = [
      elemento("div", { class: "flow-aviso", text:
        "Mensagens trazidas do Outlook pela ponte local. Nenhuma vira solicitação sozinha: o protocolo só nasce quando você revisa e registra." }),
      elemento("div", { id: "entradas-filtros" }, [montarFiltros()]),
      elemento("div", { id: "entradas-lista", class: "flow-entradas" }),
      elemento("div", { id: "entradas-paginacao" }),
    ];
    if (Api.auth.ehAdmin()) blocos.push(montarPontes());
    destino.replaceChildren(...blocos);

    carregar();
    if (Api.auth.ehAdmin()) desenharPontes();
    encerrarObservacao = Api.entradasExternas.observar(agendarRecarga);
  }

  /** O canal do realtime precisa morrer junto com a aba, não com a página. */
  function desmontar() {
    if (recargaAgendada) {
      root.clearTimeout(recargaAgendada);
      recargaAgendada = null;
    }
    if (typeof encerrarObservacao === "function") encerrarObservacao();
    encerrarObservacao = null;
  }

  root.FlowEntradas = Object.freeze({ montar, desmontar });
})(window);
