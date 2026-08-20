/**
 * GRCON Flow — administração.
 *
 * Tipos de solicitação, campos de cada tipo e usuários.
 *
 * O que se cadastra aqui é o que o formulário público mostra e o que o painel
 * destaca. É de propósito: mudar um rótulo, acrescentar uma pergunta ou criar
 * um serviço novo não deveria exigir uma publicação do aplicativo.
 */
(function (root) {
  "use strict";

  const Ui = root.FlowUi;
  const { elemento, avisar, texto } = Ui;
  const Api = root.FlowApi;

  const TIPOS_DE_CAMPO = [
    ["text", "Texto curto"],
    ["textarea", "Texto longo"],
    ["number", "Número"],
    ["select", "Lista de opções"],
    ["date", "Data"],
    ["checkbox", "Sim / não"],
  ];

  function campo(id, rotulo, valor, { tipo = "text", ajuda = "", opcoes = [], placeholder = "" } = {}) {
    let entrada;
    if (tipo === "select") {
      entrada = elemento("select", { id });
      opcoes.forEach(([opcaoValor, opcaoRotulo]) => {
        const node = elemento("option", { value: opcaoValor, text: opcaoRotulo });
        if (String(opcaoValor) === String(valor)) node.selected = true;
        entrada.append(node);
      });
    } else if (tipo === "checkbox") {
      entrada = elemento("input", { id, type: "checkbox" });
      entrada.checked = Boolean(valor);
    } else if (tipo === "textarea") {
      entrada = elemento("textarea", { id, rows: "2", placeholder });
      entrada.value = texto(valor);
    } else {
      entrada = elemento("input", { id, type: tipo, autocomplete: "off", placeholder });
      entrada.value = valor === null || valor === undefined ? "" : String(valor);
    }
    return elemento("label", { class: "flow-campo", for: id }, [
      elemento("span", { text: rotulo }),
      ajuda ? elemento("small", { text: ajuda }) : null,
      entrada,
    ]);
  }

  const ler = (id) => {
    const node = document.getElementById(id);
    if (!node) return "";
    return node.type === "checkbox" ? node.checked : node.value;
  };

  // ---------------------------------------------------------------------------
  // Campos de um tipo
  // ---------------------------------------------------------------------------
  function listaDeCampos(tipo, recarregar) {
    const lista = elemento("div", { class: "flow-itens" });

    (tipo.campos || []).forEach((item) => {
      lista.append(elemento("div", { class: "flow-item" }, [
        elemento("span", { class: "flow-item-num", text: String(item.display_order) }),
        elemento("span", { class: "flow-item-corpo" }, [
          elemento("code", { text: item.label }),
          elemento("em", { text: [
            item.field_key,
            (TIPOS_DE_CAMPO.find(([valor]) => valor === item.field_kind) || [, item.field_kind])[1],
            item.required ? "obrigatório" : "opcional",
            Array.isArray(item.options) && item.options.length ? item.options.join(" / ") : "",
          ].filter(Boolean).join(" · ") }),
        ]),
        elemento("button", {
          class: "text-button danger", type: "button", text: "Remover",
          onclick: async () => {
            if (!Ui.confirmar(`Remover o campo “${item.label}”? Solicitações já registradas mantêm o que foi respondido.`)) return;
            const { error } = await Api.tipos.removerCampo(item.id);
            if (error) { avisar(error, "erro"); return; }
            avisar("Campo removido.", "ok");
            recarregar();
          },
        }),
      ]));
    });

    if (!(tipo.campos || []).length) {
      lista.append(elemento("p", { style: "color:var(--text-3);font-size:.82rem", text:
        "Nenhuma pergunta própria. O formulário deste tipo mostra apenas o que é comum a todos." }));
    }

    const prefixo = `campo-novo-${tipo.id}`;
    const novo = elemento("div", { class: "flow-grid", style: "margin-top:.8rem" }, [
      campo(`${prefixo}-label`, "Rótulo", "", { placeholder: "Justificativa" }),
      campo(`${prefixo}-key`, "Chave", "", { placeholder: "justificativa", ajuda: "Sem espaços. É como o dado fica gravado." }),
      campo(`${prefixo}-kind`, "Tipo do campo", "text", { tipo: "select", opcoes: TIPOS_DE_CAMPO }),
      campo(`${prefixo}-options`, "Opções", "", { placeholder: "A4, A3, A2", ajuda: "Só para lista de opções. Separe por vírgula." }),
      campo(`${prefixo}-help`, "Texto de ajuda", "", { placeholder: "Aparece abaixo do rótulo." }),
      campo(`${prefixo}-order`, "Ordem", String((tipo.campos || []).length + 1), { tipo: "number" }),
      elemento("label", { class: "flow-campo", style: "flex-direction:row;align-items:center;gap:.4rem", for: `${prefixo}-required` }, [
        elemento("input", { id: `${prefixo}-required`, type: "checkbox" }),
        elemento("span", { text: "Obrigatório" }),
      ]),
    ]);

    return elemento("div", { style: "margin-top:1rem" }, [
      elemento("h4", { style: "font-size:.85rem;margin:0 0 .5rem", text: "Perguntas deste tipo" }),
      lista,
      novo,
      elemento("div", { class: "flow-acoes", style: "margin-top:.6rem" }, [
        elemento("button", {
          class: "secondary-button compact", type: "button", text: "Acrescentar pergunta",
          onclick: async () => {
            const rotulo = texto(ler(`${prefixo}-label`));
            if (!rotulo) { avisar("Informe o rótulo da pergunta.", "erro"); return; }
            const chave = texto(ler(`${prefixo}-key`))
              || rotulo.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
            const opcoes = texto(ler(`${prefixo}-options`))
              .split(",").map((valor) => valor.trim()).filter(Boolean);
            const { error } = await Api.tipos.salvarCampo({
              type_id: tipo.id,
              field_key: chave,
              label: rotulo,
              help: texto(ler(`${prefixo}-help`)),
              field_kind: ler(`${prefixo}-kind`),
              options: opcoes,
              required: ler(`${prefixo}-required`),
              display_order: Number(ler(`${prefixo}-order`)) || 0,
            });
            if (error) { avisar(error, "erro"); return; }
            avisar("Pergunta acrescentada.", "ok");
            recarregar();
          },
        }),
      ]),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Tipos
  // ---------------------------------------------------------------------------
  function cartaoTipo(tipo, recarregar) {
    const area = elemento("div");
    const prefixo = `tipo-${tipo.id}`;

    const editor = () => elemento("div", { style: "margin-top:.8rem" }, [
      elemento("div", { class: "flow-grid" }, [
        campo(`${prefixo}-label`, "Rótulo", tipo.label),
        campo(`${prefixo}-order`, "Ordem", tipo.display_order, { tipo: "number" }),
        campo(`${prefixo}-prazo`, "Prazo padrão (dias)", tipo.default_deadline_days, { tipo: "number" }),
        campo(`${prefixo}-prioridade`, "Prioridade", tipo.default_priority, {
          tipo: "select", opcoes: [["baixa", "Baixa"], ["normal", "Normal"], ["alta", "Alta"], ["urgente", "Urgente"]],
        }),
        campo(`${prefixo}-descricao`, "Descrição", tipo.description, { tipo: "textarea" }),
      ]),
      elemento("div", { class: "flow-grid", style: "margin-top:.6rem" }, [
        campo(`${prefixo}-usa-ld`, "Consulta as LDs", tipo.uses_ld, { tipo: "checkbox", ajuda: "Tria automaticamente quando houver código." }),
        campo(`${prefixo}-exige-doc`, "Exige documento", tipo.requires_document, { tipo: "checkbox", ajuda: "Marque só quando o pedido não fizer sentido sem o código." }),
        campo(`${prefixo}-aceita-doc`, "Aceita lista de documentos", tipo.allows_documents, { tipo: "checkbox" }),
        campo(`${prefixo}-busca-titulo`, "Procura pelo título", tipo.title_search, { tipo: "checkbox", ajuda: "Quando não houver código, procura candidatos pelo título." }),
        campo(`${prefixo}-nao-achar`, "Não achar é esperado", tipo.not_found_is_expected, { tipo: "checkbox", ajuda: "Ex.: Inclusão na LD — o documento ainda não deveria estar lá." }),
        campo(`${prefixo}-exige-resposta`, "Exige resposta", tipo.answer_required, { tipo: "checkbox", ajuda: "Pedidos de informação, que se encerram com uma resposta escrita." }),
        campo(`${prefixo}-ativo`, "Ativo", tipo.active, { tipo: "checkbox" }),
      ]),
      elemento("div", { class: "flow-acoes", style: "margin-top:.8rem" }, [
        elemento("button", {
          class: "primary-button compact", type: "button", text: "Salvar tipo",
          onclick: async () => {
            const { error } = await Api.tipos.salvar({
              id: tipo.id,
              code: tipo.code,
              label: ler(`${prefixo}-label`),
              description: ler(`${prefixo}-descricao`),
              display_order: Number(ler(`${prefixo}-order`)) || 0,
              default_deadline_days: Number(ler(`${prefixo}-prazo`)) || 5,
              default_priority: ler(`${prefixo}-prioridade`),
              uses_ld: ler(`${prefixo}-usa-ld`),
              requires_document: ler(`${prefixo}-exige-doc`),
              allows_documents: ler(`${prefixo}-aceita-doc`),
              allows_multiple: true,
              title_search: ler(`${prefixo}-busca-titulo`),
              not_found_is_expected: ler(`${prefixo}-nao-achar`),
              answer_required: ler(`${prefixo}-exige-resposta`),
              active: ler(`${prefixo}-ativo`),
            });
            if (error) { avisar(error, "erro"); return; }
            avisar("Tipo atualizado.", "ok");
            recarregar();
          },
        }),
      ]),
      listaDeCampos(tipo, recarregar),
    ]);

    return elemento("section", { class: "flow-card" }, [
      elemento("div", { style: "display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:flex-start" }, [
        elemento("div", {}, [
          elemento("h3", { style: "margin:0;font-size:1rem;color:var(--brand-strong)" }, [
            tipo.label,
            tipo.active ? null : elemento("span", { class: "flow-selo neutro", style: "margin-left:.5rem", text: "Inativo" }),
          ]),
          elemento("p", { style: "margin:.15rem 0 0;font-size:.8rem;color:var(--text-3)", text: tipo.description || "" }),
          elemento("p", { style: "margin:.35rem 0 0;font-size:.76rem;color:var(--text-3)", text: [
            tipo.code,
            tipo.uses_ld ? "consulta LDs" : "sem triagem",
            tipo.requires_document ? "exige documento" : "documento opcional",
            tipo.title_search ? "procura por título" : "",
            `${tipo.default_deadline_days} dia(s)`,
            `${(tipo.campos || []).length} pergunta(s)`,
          ].filter(Boolean).join(" · ") }),
        ]),
        elemento("button", {
          class: "secondary-button compact", type: "button", text: "Configurar",
          onclick: () => area.replaceChildren(area.firstChild ? null : editor()),
        }),
      ]),
      area,
    ]);
  }

  function formularioNovoTipo(recarregar) {
    return elemento("section", { class: "flow-card" }, [
      elemento("div", { class: "flow-card-head" }, [
        elemento("h3", { text: "Criar um tipo de solicitação" }),
        elemento("p", { text: "Ele aparece no formulário público assim que for salvo como ativo." }),
      ]),
      elemento("div", { class: "flow-grid" }, [
        campo("novo-tipo-label", "Rótulo", "", { placeholder: "Revisão de desenho" }),
        campo("novo-tipo-code", "Código", "", { placeholder: "REVISAO_DESENHO", ajuda: "Sem espaços. Identifica o tipo internamente." }),
        campo("novo-tipo-prazo", "Prazo padrão (dias)", "5", { tipo: "number" }),
        campo("novo-tipo-descricao", "Descrição", "", { tipo: "textarea", placeholder: "Aparece abaixo do nome, no formulário." }),
      ]),
      elemento("div", { class: "flow-grid", style: "margin-top:.6rem" }, [
        campo("novo-tipo-usa-ld", "Consulta as LDs", true, { tipo: "checkbox" }),
        campo("novo-tipo-aceita-doc", "Aceita documentos", true, { tipo: "checkbox" }),
        campo("novo-tipo-exige-doc", "Exige documento", false, { tipo: "checkbox" }),
        campo("novo-tipo-busca-titulo", "Procura pelo título", false, { tipo: "checkbox" }),
      ]),
      elemento("div", { class: "flow-acoes", style: "margin-top:.8rem" }, [
        elemento("button", {
          class: "primary-button", type: "button", text: "Criar tipo",
          onclick: async () => {
            const rotulo = texto(ler("novo-tipo-label"));
            if (!rotulo) { avisar("Informe o rótulo.", "erro"); return; }
            const codigo = texto(ler("novo-tipo-code"))
              || rotulo.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
            const { error } = await Api.tipos.salvar({
              code: codigo,
              label: rotulo,
              description: ler("novo-tipo-descricao"),
              default_deadline_days: Number(ler("novo-tipo-prazo")) || 5,
              default_priority: "normal",
              uses_ld: ler("novo-tipo-usa-ld"),
              allows_documents: ler("novo-tipo-aceita-doc"),
              requires_document: ler("novo-tipo-exige-doc"),
              title_search: ler("novo-tipo-busca-titulo"),
              allows_multiple: true,
              not_found_is_expected: false,
              answer_required: false,
              active: true,
              display_order: 99,
            });
            if (error) { avisar(error, "erro"); return; }
            avisar("Tipo criado.", "ok");
            recarregar();
          },
        }),
      ]),
    ]);
  }

  function montarTipos(destino, tipos, recarregar) {
    destino.replaceChildren(
      elemento("div", { class: "flow-aviso", text:
        "Cada tipo tem campos, prazo, fluxo e comportamento próprios. Alterar aqui muda o formulário do solicitante e as colunas do painel, sem publicar o aplicativo de novo." }),
      ...(tipos || []).map((tipo) => cartaoTipo(tipo, recarregar)),
      formularioNovoTipo(recarregar)
    );
  }

  // ---------------------------------------------------------------------------
  // Usuários
  // ---------------------------------------------------------------------------
  async function montarUsuarios(destino) {
    Ui.carregando(destino, "Carregando usuários…");
    const { data, error } = await Api.usuarios.listar();
    if (error) { Ui.vazio(destino, "Não foi possível carregar", error); return; }

    const proprietario = Api.auth.ehProprietario();
    const corpo = elemento("tbody");

    (data || []).forEach((usuario) => {
      const papel = elemento("select", { "aria-label": `Papel de ${usuario.full_name || usuario.email}` });
      Object.entries(Ui.PAPEIS).forEach(([valor, rotulo]) => {
        // Só o proprietário promove outro proprietário. O banco confere de novo.
        if (valor === "proprietario" && !proprietario) return;
        const node = elemento("option", { value: valor, text: rotulo });
        if (valor === usuario.role) node.selected = true;
        papel.append(node);
      });
      papel.addEventListener("change", async () => {
        const { error: erroPapel } = await Api.usuarios.definirPapel(usuario.id, papel.value);
        if (erroPapel) { avisar(erroPapel, "erro"); papel.value = usuario.role; return; }
        avisar(`${usuario.full_name || usuario.email} agora é ${Ui.rotuloPapel(papel.value)}.`, "ok");
        montarUsuarios(destino);
      });

      corpo.append(elemento("tr", {}, [
        elemento("td", {}, [
          elemento("strong", { text: usuario.full_name || "(sem nome)" }),
          elemento("em", { style: "display:block;font-style:normal;font-size:.74rem;color:var(--text-3)", text: usuario.email }),
        ]),
        elemento("td", { text: usuario.area || "—" }),
        elemento("td", {}, [papel]),
        elemento("td", {}, [
          elemento("span", { class: `flow-selo ${usuario.active ? "pronto" : "neutro"}`, text: usuario.active ? "Ativo" : "Inativo" }),
        ]),
        elemento("td", {}, [
          elemento("button", {
            class: "text-button", type: "button", text: usuario.active ? "Desativar" : "Reativar",
            onclick: async () => {
              const { error: erroAtivar } = await Api.usuarios.ativar(usuario.id, !usuario.active);
              if (erroAtivar) { avisar(erroAtivar, "erro"); return; }
              montarUsuarios(destino);
            },
          }),
        ]),
      ]));
    });

    destino.replaceChildren(
      elemento("div", { class: "flow-aviso", text:
        "Quem se cadastra entra como solicitante. Promova a operador quem for trabalhar nas solicitações, e a administrador quem for cuidar de tipos, LDs e usuários." }),
      elemento("div", { class: "flow-tabela-wrap" }, [
        elemento("table", { class: "flow-tabela" }, [
          elemento("thead", {}, [
            elemento("tr", {}, ["Usuário", "Área", "Papel", "Situação", ""].map((rotulo) => elemento("th", { text: rotulo }))),
          ]),
          corpo,
        ]),
      ])
    );
  }

  root.FlowAdmin = Object.freeze({ montarTipos, montarUsuarios });
})(window);
