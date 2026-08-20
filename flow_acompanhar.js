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

  function cartaoSolicitacao(solicitacao) {
    const fechada = ["concluido", "cancelado"].includes(solicitacao.status);
    return elemento("article", { class: "flow-card" }, [
      elemento("div", { style: "display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:flex-start" }, [
        elemento("div", {}, [
          elemento("div", { class: "protocolo", style: "font-family:var(--font-mono);color:var(--brand-800);font-weight:700", text: solicitacao.protocol }),
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
      itens.append(elemento("div", { class: "flow-item" }, [
        elemento("span", { class: "flow-item-num", text: String(indice + 1).padStart(2, "0") }),
        elemento("span", { class: "flow-item-corpo" }, [
          elemento("code", { text: item.document || item.requested_title || "item sem código" }),
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
        elemento("h3", { text: "Consultar por protocolo" }),
        elemento("p", { text: "Cole o número que você recebeu ao enviar a solicitação." }),
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

    app.replaceChildren(
      root.FlowUi.montarTopo({ ativo: "acompanhar", subtitulo: "Acompanhamento" }),
      elemento("main", { class: "flow-main estreito" }, [
        elemento("div", { class: "flow-page-head" }, [
          elemento("h1", { text: "Acompanhar solicitações" }),
          elemento("p", { text: "Todas as suas solicitações e o ponto em que cada uma está." }),
        ]),
        busca,
        resultado,
        elemento("h2", { style: "margin:2rem 0 .8rem;font-size:1.05rem", text: "Suas solicitações" }),
        minhas,
      ]),
      root.FlowUi.montarRodape()
    );

    // Protocolo vindo por link, logo depois do envio.
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
    minhas.replaceChildren(...data.map(cartaoSolicitacao));
  }

  (async function iniciar() {
    const perfil = await root.FlowUi.exigirSessao();
    if (!perfil) return;
    montar();
  })();
})(window);
