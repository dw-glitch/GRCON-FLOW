/**
 * GRCON Flow — normas, revisões e catálogos de códigos da qualidade.
 *
 * O PDF é a evidência controlada; os catálogos são a parte estruturada que o
 * importador consegue validar. Uma revisão nova nasce como rascunho e só passa
 * a reger as próximas LDs quando um administrador a ativa explicitamente.
 */
(function (root) {
  "use strict";

  const Ui = root.FlowUi;
  const { elemento, avisar, texto, dataHora } = Ui;
  const Api = root.FlowApi;
  const estado = { destino: null, normas: [], catalogo: "TIPOS_RELATORIO", codigos: [] };

  const CATALOGOS = [
    ["TIPOS_RELATORIO", "Tipos de relatório — ET Rev. Q"],
    ["CATEGORIAS_N1710", "Categorias documentais — N-1710"],
    ["DISCIPLINAS_RELATORIO", "Disciplinas de relatório — ET Rev. Q"],
    ["EMISSORES_RELATORIO", "Emissores autorizados"],
    ["UNIDADES_RELATORIO", "Unidades autorizadas"],
  ];

  function statusVersao(status) {
    const mapa = {
      ativa: ["pronto", "Vigente"],
      rascunho: ["candidatos", "Rascunho"],
      substituida: ["neutro", "Substituída"],
      erro: ["nao-localizado", "Falhou"],
    };
    const [classe, rotulo] = mapa[status] || mapa.rascunho;
    return elemento("span", { class: `flow-selo ${classe}`, text: rotulo });
  }

  function formularioRevisao() {
    const codigo = elemento("input", { id: "norma-codigo", type: "text", placeholder: "Ex.: ET-5290.00-22000-912-1LV-001" });
    const titulo = elemento("input", { id: "norma-titulo", type: "text", placeholder: "Título controlado da norma" });
    const revisao = elemento("input", { id: "norma-revisao", type: "text", placeholder: "Ex.: Q" });
    const vigencia = elemento("input", { id: "norma-vigencia", type: "date" });
    const arquivo = elemento("input", { id: "norma-arquivo", type: "file", accept: ".pdf" });
    const notas = elemento("textarea", { id: "norma-notas", rows: "2", placeholder: "O que mudou nesta revisão" });
    const botao = elemento("button", {
      class: "primary-button", type: "button", text: "Registrar como rascunho",
      onclick: async () => {
        const pdf = arquivo.files && arquivo.files[0];
        if (!texto(codigo.value) || !texto(titulo.value) || !texto(revisao.value)) {
          avisar("Informe código, título e revisão.", "erro"); return;
        }
        if (!pdf) { avisar("Anexe o PDF controlado desta revisão.", "erro"); return; }
        botao.disabled = true;
        const { error } = await Api.normas.criarVersao({
          norm_code: codigo.value,
          norm_title: titulo.value,
          revision: revisao.value,
          effective_date: vigencia.value,
          notes: notas.value,
        }, pdf);
        botao.disabled = false;
        if (error) { avisar(error, "erro"); return; }
        avisar("Revisão registrada como rascunho. Ative-a depois da conferência.", "ok");
        await carregar();
      },
    });

    return elemento("section", { class: "flow-card" }, [
      elemento("div", { class: "flow-card-head" }, [
        elemento("h3", { text: "Registrar nova revisão" }),
        elemento("p", { text: "O arquivo fica guardado com data, autor e histórico. Registrar não muda a regra vigente até você clicar em Ativar." }),
      ]),
      elemento("div", { class: "flow-grid" }, [
        elemento("label", { class: "flow-campo", for: codigo.id }, [elemento("span", { text: "Código da norma" }), codigo]),
        elemento("label", { class: "flow-campo", for: titulo.id }, [elemento("span", { text: "Título" }), titulo]),
        elemento("label", { class: "flow-campo", for: revisao.id }, [elemento("span", { text: "Revisão" }), revisao]),
        elemento("label", { class: "flow-campo", for: vigencia.id }, [elemento("span", { text: "Vigência" }), vigencia]),
        elemento("label", { class: "flow-campo", for: arquivo.id }, [elemento("span", { text: "PDF controlado" }), arquivo]),
        elemento("label", { class: "flow-campo larga", for: notas.id }, [elemento("span", { text: "Notas da revisão" }), notas]),
      ]),
      elemento("div", { class: "flow-acoes", style: "margin-top:.8rem" }, [botao]),
    ]);
  }

  function cartaoNorma(norma) {
    const versoes = (norma.versoes || []).slice().sort((a, b) =>
      new Date(b.created_at || 0) - new Date(a.created_at || 0));
    const itens = elemento("div", { class: "flow-itens" });
    versoes.forEach((versao) => {
      itens.append(elemento("div", { class: "flow-item" }, [
        elemento("span", { class: "flow-item-num" }, [statusVersao(versao.status)]),
        elemento("span", { class: "flow-item-corpo" }, [
          elemento("code", { text: `Rev. ${versao.revision || "—"}` }),
          elemento("em", { text: [
            versao.effective_date ? `vigente desde ${versao.effective_date}` : "sem data de vigência",
            versao.file_name || "referência cadastrada sem arquivo",
            dataHora(versao.created_at),
          ].filter(Boolean).join(" · ") }),
          versao.notes ? elemento("em", { text: versao.notes }) : null,
        ]),
        versao.status !== "ativa" && versao.status !== "erro"
          ? elemento("button", {
              class: "text-button", type: "button", text: "Ativar",
              onclick: async () => {
                if (!Ui.confirmar(`Ativar a revisão ${versao.revision} de ${norma.code}? As próximas análises passarão a usar essa regra.`)) return;
                const { error } = await Api.normas.ativarVersao(versao.id);
                if (error) { avisar(error, "erro"); return; }
                avisar("Revisão normativa ativada.", "ok");
                await carregar();
              },
            }) : null,
      ]));
    });
    return elemento("section", { class: "flow-card" }, [
      elemento("div", { class: "flow-card-head" }, [
        elemento("h3", { text: norma.code }),
        elemento("p", { text: norma.title }),
      ]),
      versoes.length ? itens : elemento("div", { class: "flow-vazio", text: "Nenhuma revisão cadastrada." }),
    ]);
  }

  async function carregarCodigos() {
    const destino = document.getElementById("normas-catalogo-lista");
    if (!destino) return;
    Ui.carregando(destino, "Carregando catálogo…");
    const { data, error } = await Api.normas.listarCodigos(estado.catalogo);
    if (error) { Ui.vazio(destino, "Não foi possível carregar", error); return; }
    estado.codigos = data || [];
    const linhas = elemento("div", { class: "flow-itens" });
    estado.codigos.slice(0, 200).forEach((item) => {
      linhas.append(elemento("div", { class: "flow-item" }, [
        elemento("span", { class: "flow-item-num" }, [
          elemento("span", { class: `flow-selo ${item.active ? "pronto" : "neutro"}`, text: item.active ? "Ativo" : "Inativo" }),
        ]),
        elemento("span", { class: "flow-item-corpo" }, [
          elemento("code", { text: item.entry_code }),
          elemento("em", { text: item.label || "Sem descrição" }),
        ]),
        elemento("button", {
          class: `text-button ${item.active ? "danger" : ""}`, type: "button", text: item.active ? "Desativar" : "Reativar",
          onclick: async () => {
            const { error: erro } = await Api.normas.salvarCodigo(estado.catalogo, item.entry_code, item.label, !item.active);
            if (erro) { avisar(erro, "erro"); return; }
            await carregarCodigos();
          },
        }),
      ]));
    });
    destino.replaceChildren(
      elemento("p", { style: "font-size:.78rem;color:var(--text-3)", text:
        `${estado.codigos.length.toLocaleString("pt-BR")} código(s). ${estado.codigos.length > 200 ? "Mostrando os 200 primeiros." : ""}` }),
      linhas
    );
  }

  function gerenciadorCatalogos() {
    const seletor = elemento("select", { id: "normas-catalogo" });
    CATALOGOS.forEach(([valor, rotulo]) => seletor.append(elemento("option", { value: valor, text: rotulo })));
    seletor.value = estado.catalogo;
    seletor.addEventListener("change", () => { estado.catalogo = seletor.value; carregarCodigos(); });
    const codigo = elemento("input", { id: "normas-codigo", type: "text", placeholder: "Código" });
    const rotulo = elemento("input", { id: "normas-rotulo", type: "text", placeholder: "Descrição" });
    const lista = elemento("div", { id: "normas-catalogo-lista" });
    const card = elemento("section", { class: "flow-card" }, [
      elemento("div", { class: "flow-card-head" }, [
        elemento("h3", { text: "Catálogos usados na validação" }),
        elemento("p", { text: "Adicionar ou desativar um código altera as próximas pré-análises de LD; versões já publicadas preservam o relatório que usaram." }),
      ]),
      elemento("div", { class: "flow-grid" }, [
        elemento("label", { class: "flow-campo", for: seletor.id }, [elemento("span", { text: "Catálogo" }), seletor]),
        elemento("label", { class: "flow-campo", for: codigo.id }, [elemento("span", { text: "Código" }), codigo]),
        elemento("label", { class: "flow-campo", for: rotulo.id }, [elemento("span", { text: "Descrição" }), rotulo]),
      ]),
      elemento("div", { class: "flow-acoes", style: "margin:.7rem 0" }, [
        elemento("button", {
          class: "primary-button compact", type: "button", text: "Adicionar ou atualizar",
          onclick: async () => {
            if (!texto(codigo.value)) { avisar("Informe o código.", "erro"); return; }
            const { error } = await Api.normas.salvarCodigo(estado.catalogo, codigo.value, rotulo.value, true);
            if (error) { avisar(error, "erro"); return; }
            codigo.value = ""; rotulo.value = "";
            avisar("Catálogo atualizado.", "ok");
            await carregarCodigos();
          },
        }),
      ]),
      lista,
    ]);
    setTimeout(carregarCodigos, 0);
    return card;
  }

  function desenhar() {
    const blocos = [
      elemento("div", { class: "flow-aviso", text:
        "Normas ficam versionadas. Uma revisão substituída continua no histórico; somente a versão marcada como vigente alimenta a validação de novas LDs." }),
      ...estado.normas.map(cartaoNorma),
      formularioRevisao(),
      gerenciadorCatalogos(),
    ];
    estado.destino.replaceChildren(...blocos);
  }

  async function carregar() {
    if (!estado.destino) return;
    Ui.carregando(estado.destino, "Carregando normas e revisões…");
    const { data, error } = await Api.normas.listar();
    if (error) { Ui.vazio(estado.destino, "Não foi possível carregar", error); return; }
    estado.normas = data || [];
    desenhar();
  }

  function montar(destino) {
    estado.destino = destino;
    carregar();
  }

  root.FlowNormas = Object.freeze({ montar });
})(window);
