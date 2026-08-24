/**
 * GRCON Flow — acompanhamento do solicitante.
 *
 * Responde a uma pergunta só: "como está o meu pedido?". Mostra o que é do
 * solicitante e nada da operação interna — sem responsável, sem comentário de
 * equipe, sem métrica. Quem tem papel de equipe usa o painel para o resto.
 */
(function (root) {
  "use strict";

  const { elemento, avisar, seloStatus, seloPrazo, data: fmtData, texto } = root.FlowUi;
  const Api = root.FlowApi;
  const app = document.getElementById("app");

  function progresso(feitos, total) {
    const proporcao = total > 0 ? Math.round((feitos / total) * 100) : 0;
    return elemento("div", { class: "flow-progresso" }, [
      elemento("div", { class: "flow-progresso-barra" }, [
        elemento("i", { style: `width:${proporcao}%` }),
      ]),
      elemento("small", { text: `${feitos} de ${total} concluído(s)` }),
    ]);
  }

  function situacaoLd(item) {
    const status = texto(item.ld_presence_status);
    if (status === "NOVO") return "NOVO · não consta nas LDs vigentes";
    if (status === "JA_EXISTE") {
      const base = `JÁ EXISTE${texto(item.ld_name) ? ` · ${texto(item.ld_name)}` : ""}`;
      return texto(item.allocation)
        ? `${base} · alocação ${texto(item.allocation)}`
        : `${base} · sem alocação identificada`;
    }
    if (status === "JA_EXISTE_DIVERGENTE") {
      return texto(item.allocation)
        ? `JÁ EXISTE · validar divergência · alocação ${texto(item.allocation)}`
        : "JÁ EXISTE · validar informações nas LDs";
    }
    if (status === "POSSIVEL_EXISTENTE") return "POSSÍVEL EXISTENTE · código em validação";
    if (status === "PENDENTE_IDENTIFICACAO") return "IDENTIFICAÇÃO PENDENTE · código ainda não confirmado";
    return "";
  }

  /**
   * Cartão de uma solicitação própria. O protocolo é um botão: antes, ver o
   * detalhe de um pedido da própria lista exigia copiá-lo à mão para o campo de
   * busca logo acima — a informação estava na tela e mesmo assim dava trabalho.
   */
  function cartaoSolicitacao(solicitacao, aoAbrir) {
    const fechada = ["concluido", "cancelado"].includes(solicitacao.status);
    const abrir = () => aoAbrir(solicitacao.protocol);
    return elemento("article", { class: "flow-card" }, [
      elemento("div", { style: "display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:flex-start" }, [
        elemento("div", {}, [
          elemento("button", {
            class: "flow-protocolo-link", type: "button", text: solicitacao.protocol,
            "aria-label": `Ver o andamento de ${solicitacao.protocol}`, onclick: abrir,
          }),
          elemento("strong", { style: "display:block;margin-top:.15rem", text: solicitacao.type_label }),
          solicitacao.summary ? elemento("span", { style: "font-size:.84rem;color:var(--text-3)", text: solicitacao.summary }) : null,
        ]),
        elemento("div", { style: "display:flex;gap:.4rem;flex-wrap:wrap;align-items:center" }, [
          seloStatus(solicitacao.status),
          seloPrazo(solicitacao.due_at, fechada),
        ]),
      ]),
      elemento("dl", { class: "flow-dados", style: "margin-top:1rem" }, [
        elemento("div", { class: "flow-dado" }, [
          elemento("dt", { text: "Recebida em" }),
          elemento("dd", { text: fmtData(solicitacao.created_at) }),
        ]),
        elemento("div", { class: "flow-dado" }, [
          elemento("dt", { text: "Itens" }),
          elemento("dd", {}, [progresso(solicitacao.items_done, solicitacao.items_total)]),
        ]),
        solicitacao.answer ? elemento("div", { class: "flow-dado", style: "grid-column:1/-1" }, [
          elemento("dt", { text: "Resposta" }),
          elemento("dd", { style: "white-space:pre-wrap", text: solicitacao.answer }),
        ]) : null,
      ]),
      elemento("div", { class: "flow-acoes", style: "margin-top:.9rem" }, [
        elemento("button", { class: "secondary-button compact", type: "button", text: "Ver detalhes", onclick: abrir }),
      ]),
    ]);
  }

  async function consultarProtocolo(valor, destino) {
    const protocolo = texto(valor).toUpperCase();
    if (!protocolo) { avisar("Informe o protocolo.", "erro"); return; }
    root.FlowUi.carregando(destino, "Consultando…");
    const { data, error } = await Api.solicitacoes.porProtocolo(protocolo);
    if (error) { root.FlowUi.vazio(destino, "Não foi possível consultar", error); return; }
    if (!data) {
      root.FlowUi.vazio(destino, "Protocolo não encontrado",
        "Confira o número. Ele tem o formato FLOW-2026-000001.");
      return;
    }

    const itens = elemento("div", { class: "flow-itens" });
    (data.items || []).forEach((item, indice) => {
      const ld = situacaoLd(item);
      const detalhes = [
        texto(item.discipline),
        texto(item.revision) ? `rev. ${texto(item.revision)}` : "",
        texto(item.last_grdt) ? `última GRDT ${texto(item.last_grdt)}` : "",
      ].filter(Boolean).join(" · ");

      itens.append(elemento("div", { class: "flow-item" }, [
        elemento("span", { class: "flow-item-num", text: String(indice + 1).padStart(2, "0") }),
        elemento("span", { class: "flow-item-corpo" }, [
          elemento("code", { text: item.document || "Código ainda não informado" }),
          item.requested_title ? elemento("strong", { text: item.requested_title }) : null,
          ld ? elemento("em", { text: ld }) : null,
          detalhes ? elemento("em", { text: detalhes }) : null,
          item.requires_pdf_excel_pair ? elemento("em", { text:
            item.pdf_attachment_ready && item.excel_attachment_ready
              ? "N-1710 · PDF + Excel recebidos"
              : `N-1710 · aguardando ${[!item.pdf_attachment_ready ? "PDF" : "", !item.excel_attachment_ready ? "Excel" : ""].filter(Boolean).join(" + ")}`
          }) : null,
          item.answer ? elemento("em", { text: item.answer }) : null,
        ]),
        seloStatus(item.status),
      ]));
    });

    destino.replaceChildren(elemento("div", { class: "flow-card" }, [
      elemento("div", { class: "flow-card-head" }, [
        elemento("h3", { text: data.protocol }),
        elemento("p", { text: data.type_label }),
      ]),
      elemento("div", { style: "display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:1rem" }, [
        seloStatus(data.status),
        seloPrazo(data.due_at, ["concluido", "cancelado"].includes(data.status)),
      ]),
      progresso(data.items_done, data.items_total),
      data.answer ? elemento("div", { class: "flow-aviso ok", style: "margin-top:1rem;white-space:pre-wrap", text: data.answer }) : null,
      itens,
    ]));
  }

  async function montar() {
    const resultado = elemento("div", { id: "acomp-resultado" });
    const entrada = elemento("input", {
      id: "acomp-protocolo", type: "search", placeholder: "FLOW-2026-000001", autocomplete: "off",
    });

    const busca = elemento("form", { class: "flow-card" }, [
      elemento("div", { class: "flow-card-head" }, [
        elemento("h3", { text: "Buscar protocolo" }),
      ]),
      elemento("div", { class: "flow-filtros", style: "margin:0" }, [
        elemento("label", { class: "flow-campo busca", for: "acomp-protocolo" }, [
          elemento("span", { text: "Protocolo" }), entrada,
        ]),
        elemento("button", { class: "primary-button", type: "submit", text: "Consultar" }),
      ]),
    ]);
    busca.addEventListener("submit", (evento) => {
      evento.preventDefault();
      consultarProtocolo(entrada.value, resultado);
    });

    const minhas = elemento("div", { id: "acomp-minhas" });

    // Abrir um pedido da lista preenche a busca e rola até o resultado: a tela
    // continua sendo uma só, e fica claro de onde veio o que apareceu.
    const abrirProtocolo = (protocolo) => {
      entrada.value = protocolo;
      consultarProtocolo(protocolo, resultado);
      resultado.scrollIntoView({ behavior: "smooth", block: "start" });
    };

    app.replaceChildren(
      root.FlowUi.montarTopo({ ativo: "acompanhar", subtitulo: "Acompanhamento" }),
      elemento("main", { class: "flow-main estreito" }, [
        elemento("div", { class: "flow-page-head" }, [
          elemento("h1", { text: "Acompanhar" }),
        ]),
        busca,
        resultado,
        elemento("h2", { style: "margin:2rem 0 .8rem;font-size:1.05rem", text: "Suas solicitações" }),
        minhas,
      ]),
      root.FlowUi.montarRodape()
    );

    const parametros = new URLSearchParams(root.location.search);
    const protocoloDaUrl = parametros.get("protocolo");
    if (protocoloDaUrl) { entrada.value = protocoloDaUrl; consultarProtocolo(protocoloDaUrl, resultado); }

    root.FlowUi.carregando(minhas);
    const { data, error } = await Api.solicitacoes.listar({ meus: true, limite: 50 });
    if (error) { root.FlowUi.vazio(minhas, "Não foi possível carregar", error); return; }
    if (!data.length) {
      root.FlowUi.vazio(minhas, "Você ainda não registrou nenhuma solicitação",
        "Quando registrar, ela aparece aqui com o protocolo e o andamento.");
      return;
    }
    minhas.replaceChildren(
      elemento("p", { class: "flow-lista-resumo", text:
        `${data.length} solicitação(ões)${data.length >= 50 ? " · mostrando as 50 mais recentes" : ""}.` }),
      ...data.map((solicitacao) => cartaoSolicitacao(solicitacao, abrirProtocolo))
    );
  }

  (async function iniciar() {
    const perfil = await root.FlowUi.exigirSessao();
    if (!perfil) return;
    montar();
  })();
})(window);
