/**
 * GRCON Flow — portal do solicitante.
 *
 * A tela é montada nesta ordem, de propósito:
 *   1. o que você precisa   → o tipo de serviço
 *   2. o formulário daquele tipo, e só dele
 *   3. conferência e envio
 *
 * O formulário vem do banco (flow_type_fields), não do código: quando o
 * administrador cria um tipo novo, ele aparece aqui sem nova publicação.
 *
 * Duas regras que valem para a tela inteira:
 *   — Código de documento não é obrigatório. Quem só tem o título, ou só uma
 *     pergunta, registra do mesmo jeito.
 *   — O envio nunca é bloqueado pela triagem. Primeiro registra e devolve o
 *     protocolo; a consulta às LDs acontece depois.
 */
(function (root) {
  "use strict";

  const { elemento, avisar, texto, esc } = root.FlowUi;
  const Api = root.FlowApi;
  const Docs = root.FlowDocs;
  const app = document.getElementById("app");

  const estado = {
    tipos: [],
    tipo: null,
    etapa: 1,
    documentos: [],
    anexos: [],
    formulario: {},
    enviando: false,
  };

  const ICONES = {
    upload: "M12 16V4M8 8l4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3",
    alocacao: "M4 6h16M4 12h10M4 18h7M17 14l3 3-3 3",
    mais: "M12 5v14M5 12h14",
    texto: "M6 4h12M12 4v16M8 20h8",
    ajuste: "M4 12h6M14 12h6M10 8v8M14 6v4",
    pessoa: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0",
    impressora: "M6 9V3h12v6M6 18H4v-6h16v6h-2M8 14h8v7H8z",
    busca: "M10 16a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM14.5 14.5L21 21",
    pergunta: "M9.1 9a3 3 0 1 1 4 2.8c-.8.3-1.1 1-1.1 1.7v.5M12 17.5h.01",
    documento: "M6 3h9l4 4v14H6zM15 3v4h4",
  };

  function icone(nome) {
    return elemento("svg", {
      viewBox: "0 0 24 24", "aria-hidden": "true",
      html: `<path d="${ICONES[nome] || ICONES.documento}"></path>`,
    });
  }

  // ---------------------------------------------------------------------------
  // Etapas
  // ---------------------------------------------------------------------------
  function montarEtapas() {
    const passos = ["O que você precisa", "Detalhes do pedido", "Conferir e enviar"];
    const lista = elemento("ol", { class: "flow-etapas", "aria-label": "Etapas" });
    passos.forEach((rotulo, indice) => {
      const numero = indice + 1;
      const classe = numero === estado.etapa ? "atual" : numero < estado.etapa ? "feita" : "";
      lista.append(elemento("li", { class: `flow-etapa ${classe}` }, [
        elemento("b", { text: numero < estado.etapa ? "" : String(numero) }),
        elemento("span", { text: rotulo }),
      ]));
      if (numero < passos.length) lista.append(elemento("li", { class: "flow-etapa-sep", "aria-hidden": "true", text: "›" }));
    });
    return lista;
  }

  // ---------------------------------------------------------------------------
  // Etapa 1 — escolha do tipo
  // ---------------------------------------------------------------------------
  function montarEscolha() {
    const grade = elemento("div", { class: "flow-tipos", role: "group", "aria-label": "Tipos de solicitação" });
    estado.tipos.forEach((tipo) => {
      grade.append(elemento("button", {
        class: "flow-tipo", type: "button",
        "aria-pressed": estado.tipo && estado.tipo.id === tipo.id ? "true" : "false",
        onclick: () => {
          // Trocar de serviço zera o que era do serviço anterior: manter
          // resposta de um campo que não existe mais só geraria confusão.
          estado.tipo = tipo;
          estado.formulario = {};
          estado.documentos = [];
          estado.anexos = [];
          estado.etapa = 2;
          render();
        },
      }, [
        icone(tipo.icon),
        elemento("span", {}, [
          elemento("b", { text: tipo.label }),
          elemento("small", { text: tipo.description || "" }),
        ]),
      ]));
    });

    return elemento("section", { class: "flow-card" }, [
      elemento("div", { class: "flow-card-head" }, [
        elemento("h2", { text: "O que você deseja solicitar?" }),
        elemento("p", { text: "Escolha o serviço. O formulário se ajusta ao que aquele pedido realmente precisa." }),
      ]),
      grade,
    ]);
  }

  // ---------------------------------------------------------------------------
  // Etapa 2 — formulário do tipo
  // ---------------------------------------------------------------------------
  function campoTexto(id, rotulo, { valor = "", ajuda = "", placeholder = "", obrigatorio = false, tipo = "text", opcoes = [] } = {}) {
    const rotuloNode = elemento("span", {}, [
      rotulo,
      obrigatorio ? elemento("span", { class: "obrigatorio", text: "*", "aria-hidden": "true" }) : null,
    ]);

    let entrada;
    if (tipo === "textarea") {
      entrada = elemento("textarea", { id, rows: "3", placeholder });
      entrada.value = valor;
    } else if (tipo === "select") {
      entrada = elemento("select", { id });
      entrada.append(elemento("option", { value: "", text: "Selecione…" }));
      opcoes.forEach((opcao) => {
        const node = elemento("option", { value: opcao, text: opcao });
        if (opcao === valor) node.selected = true;
        entrada.append(node);
      });
    } else if (tipo === "checkbox") {
      entrada = elemento("input", { id, type: "checkbox" });
      entrada.checked = Boolean(valor);
    } else {
      entrada = elemento("input", { id, type: tipo, placeholder, autocomplete: "off" });
      entrada.value = valor;
    }

    return elemento("label", { class: "flow-campo", for: id }, [
      rotuloNode,
      ajuda ? elemento("small", { text: ajuda }) : null,
      entrada,
    ]);
  }

  function valorDoCampo(node) {
    const entrada = node.querySelector("input, select, textarea");
    if (!entrada) return "";
    return entrada.type === "checkbox" ? entrada.checked : entrada.value;
  }

  /** Entrada de documentos: colar lista, escolher arquivos ou arrastar. */
  function montarDocumentos() {
    const tipo = estado.tipo;
    const bloco = elemento("section", { class: "flow-card" });

    const explicacao = tipo.requires_document
      ? "Informe os documentos deste pedido. Você pode colar a lista, escolher os arquivos ou arrastá-los para cá."
      : "Se você tiver os códigos ou os arquivos, informe aqui. Se não tiver, pode deixar em branco — descreva o pedido abaixo e nós identificamos.";

    bloco.append(elemento("div", { class: "flow-card-head" }, [
      elemento("h3", {}, [
        "Documentos",
        tipo.requires_document ? elemento("span", { class: "obrigatorio", text: "*", "aria-hidden": "true" }) : null,
      ]),
      elemento("p", { text: explicacao }),
    ]));

    const entradaArquivos = elemento("input", { type: "file", multiple: true, hidden: true, id: "sol-arquivos" });
    const area = elemento("div", {
      class: "flow-drop", tabindex: "0", role: "button",
      "aria-label": "Escolher ou arrastar arquivos",
      onclick: () => entradaArquivos.click(),
      onkeydown: (evento) => {
        if (evento.key === "Enter" || evento.key === " ") { evento.preventDefault(); entradaArquivos.click(); }
      },
    }, [
      icone("upload"),
      elemento("strong", { text: "Arraste os arquivos aqui" }),
      elemento("span", { text: "ou clique para escolher. O código sai do nome do arquivo, quando ele tiver um." }),
      entradaArquivos,
    ]);

    ["dragenter", "dragover"].forEach((evento) => area.addEventListener(evento, (e) => {
      e.preventDefault(); area.classList.add("sobre");
    }));
    ["dragleave", "drop"].forEach((evento) => area.addEventListener(evento, (e) => {
      e.preventDefault(); area.classList.remove("sobre");
    }));
    area.addEventListener("drop", (evento) => receberArquivos(evento.dataTransfer.files));
    entradaArquivos.addEventListener("change", () => { receberArquivos(entradaArquivos.files); entradaArquivos.value = ""; });

    const colar = elemento("textarea", {
      id: "sol-colar", rows: "3", placeholder:
        "Ou cole os códigos, um por linha.\nC1O_RNEST_U32_3.1.1.1_INS_RIR_SPE-AST-320019\n5290.00-22313-91A-C1O-004",
    });

    const acoes = elemento("div", { class: "flow-acoes" }, [
      elemento("button", {
        class: "secondary-button compact", type: "button", text: "Acrescentar da lista",
        onclick: () => {
          const novos = Docs.daListaColada(colar.value);
          if (!novos.length) { avisar("Nenhum código reconhecido no texto colado.", "erro"); return; }
          acrescentar(novos);
          colar.value = "";
        },
      }),
      elemento("span", { class: "flow-carregando", id: "sol-contagem", style: "padding:0;font-size:.78rem" }),
    ]);

    const lista = elemento("div", { class: "flow-itens", id: "sol-lista" });

    bloco.append(area, elemento("label", { class: "flow-campo", for: "sol-colar" }, [
      elemento("span", { text: "Ou cole a lista de códigos" }), colar,
    ]), acoes, lista);

    desenharLista(lista, acoes.querySelector("#sol-contagem"));
    return bloco;
  }

  function receberArquivos(arquivos) {
    const lista = Array.from(arquivos || []);
    if (!lista.length) return;
    const limite = (Api.config.uploadMaxMb || 25) * 1024 * 1024;
    const grandes = lista.filter((arquivo) => arquivo.size > limite);
    if (grandes.length) {
      avisar(`${grandes.length} arquivo(s) passaram de ${Api.config.uploadMaxMb || 25} MB e não foram anexados.`, "erro");
    }
    const aceitos = lista.filter((arquivo) => arquivo.size <= limite);
    estado.anexos = estado.anexos.concat(aceitos);
    acrescentar(Docs.deArquivos(aceitos));
  }

  function acrescentar(novos) {
    const { itens, removidos } = Docs.semRepetidos(estado.documentos.concat(novos));
    estado.documentos = itens;
    if (removidos.length) avisar(`${removidos.length} código(s) repetido(s) foram descartados.`);
    render();
  }

  function desenharLista(destino, contagem) {
    destino.replaceChildren();
    if (contagem) {
      contagem.textContent = estado.documentos.length
        ? `${estado.documentos.length} item(ns) nesta solicitação`
        : "Nenhum item informado ainda";
    }
    estado.documentos.forEach((item, indice) => {
      const semCodigo = !item.document;
      destino.append(elemento("div", { class: `flow-item ${semCodigo ? "flow-item-sem-codigo" : ""}` }, [
        elemento("span", { class: "flow-item-num", text: String(indice + 1).padStart(2, "0") }),
        elemento("span", { class: "flow-item-corpo" }, [
          elemento("code", { text: item.document || "sem código — vamos identificar" }),
          item.requested_title || item.file_name
            ? elemento("em", { text: item.requested_title || item.file_name })
            : null,
        ]),
        elemento("button", {
          class: "text-button danger", type: "button", text: "Remover",
          "aria-label": `Remover item ${indice + 1}`,
          onclick: () => { estado.documentos.splice(indice, 1); render(); },
        }),
      ]));
    });
  }

  function montarFormulario() {
    const tipo = estado.tipo;
    const perfil = Api.auth.profile || {};
    const blocos = [];

    // Quem está pedindo. Vem preenchido do perfil: ninguém deveria digitar o
    // próprio nome toda vez.
    blocos.push(elemento("section", { class: "flow-card" }, [
      elemento("div", { class: "flow-card-head" }, [
        elemento("h3", { text: "Quem está solicitando" }),
        elemento("p", { text: "Confirme seus dados. Usamos para responder e para o Controle de Solicitações." }),
      ]),
      elemento("div", { class: "flow-grid" }, [
        campoTexto("sol-nome", "Nome", { valor: estado.formulario._nome ?? (perfil.full_name || ""), obrigatorio: true }),
        campoTexto("sol-area", "Área / setor", { valor: estado.formulario._area ?? (perfil.area || "") }),
        campoTexto("sol-contato", "Contato", { valor: estado.formulario._contato ?? (perfil.contact || perfil.email || ""), ajuda: "E-mail ou ramal para retorno." }),
      ]),
    ]));

    // Campos próprios do tipo.
    if (tipo.campos && tipo.campos.length) {
      const grade = elemento("div", { class: "flow-grid" });
      tipo.campos.forEach((campo) => {
        const largo = campo.field_kind === "textarea";
        const node = campoTexto(`campo-${campo.field_key}`, campo.label, {
          valor: estado.formulario[campo.field_key] || "",
          ajuda: campo.help,
          placeholder: campo.placeholder,
          obrigatorio: campo.required,
          tipo: campo.field_kind === "documents" || campo.field_kind === "files" ? "text" : campo.field_kind,
          opcoes: Array.isArray(campo.options) ? campo.options : [],
        });
        node.dataset.campo = campo.field_key;
        node.dataset.obrigatorio = campo.required ? "1" : "";
        if (largo) node.classList.add("larga");
        grade.append(node);
      });
      blocos.push(elemento("section", { class: "flow-card" }, [
        elemento("div", { class: "flow-card-head" }, [
          elemento("h3", { text: tipo.label }),
          elemento("p", { text: "As informações que este pedido precisa." }),
        ]),
        grade,
      ]));
    }

    if (tipo.allows_documents) blocos.push(montarDocumentos());

    // Observações. Sempre presente: é onde cabe o que o formulário não previu.
    blocos.push(elemento("section", { class: "flow-card" }, [
      elemento("div", { class: "flow-card-head" }, [
        elemento("h3", { text: "Mais alguma coisa?" }),
        elemento("p", { text: "Prioridade, prazo, contexto — o que ajudar quem vai executar." }),
      ]),
      campoTexto("sol-observacao", "Observações", {
        valor: estado.formulario._observacao || "", tipo: "textarea",
        placeholder: "Prioridade para emissão desta semana…",
      }),
    ]));

    const navegacao = elemento("div", { class: "flow-acoes", style: "margin-top:1.2rem" }, [
      elemento("button", {
        class: "secondary-button", type: "button", text: "Voltar",
        onclick: () => { guardarFormulario(); estado.etapa = 1; render(); },
      }),
      elemento("button", {
        class: "primary-button", type: "button", text: "Conferir o pedido",
        onclick: () => {
          guardarFormulario();
          const problema = validar();
          if (problema) { avisar(problema, "erro"); return; }
          estado.etapa = 3;
          render();
        },
      }),
    ]);

    return elemento("div", {}, blocos.concat([navegacao]));
  }

  function guardarFormulario() {
    const pegar = (id) => {
      const node = document.getElementById(id);
      return node ? node.value : "";
    };
    estado.formulario._nome = pegar("sol-nome");
    estado.formulario._area = pegar("sol-area");
    estado.formulario._contato = pegar("sol-contato");
    estado.formulario._observacao = pegar("sol-observacao");
    (estado.tipo.campos || []).forEach((campo) => {
      const node = document.querySelector(`[data-campo="${campo.field_key}"]`);
      if (node) estado.formulario[campo.field_key] = valorDoCampo(node);
    });
  }

  /** Devolve a primeira pendência, ou null quando está tudo certo. */
  function validar() {
    const tipo = estado.tipo;
    if (!texto(estado.formulario._nome)) return "Informe o seu nome.";
    const faltando = (tipo.campos || []).find(
      (campo) => campo.required && !texto(estado.formulario[campo.field_key])
    );
    if (faltando) return `Preencha “${faltando.label}”.`;
    if (tipo.requires_document && !estado.documentos.length) {
      return "Informe pelo menos um documento para este tipo de solicitação.";
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Etapa 3 — conferência
  // ---------------------------------------------------------------------------
  function montarConferencia() {
    const tipo = estado.tipo;
    const dados = elemento("dl", { class: "flow-dados" });

    const linha = (rotulo, valor) => {
      if (!texto(valor)) return;
      dados.append(elemento("div", { class: "flow-dado" }, [
        elemento("dt", { text: rotulo }),
        elemento("dd", { text: texto(valor) }),
      ]));
    };

    linha("Serviço", tipo.label);
    linha("Solicitante", estado.formulario._nome);
    linha("Área", estado.formulario._area);
    linha("Contato", estado.formulario._contato);
    (tipo.campos || []).forEach((campo) => linha(campo.label, estado.formulario[campo.field_key]));
    linha("Observações", estado.formulario._observacao);

    const itens = elemento("div", { class: "flow-itens" });
    if (estado.documentos.length) {
      desenharLista(itens, null);
    } else if (tipo.allows_documents) {
      itens.append(elemento("p", { class: "flow-aviso", text: "Nenhum documento informado. Tudo bem — vamos identificar a partir do que você descreveu." }));
    }

    const anexosResumo = estado.anexos.length
      ? elemento("p", { class: "flow-aviso", text: `${estado.anexos.length} arquivo(s) serão anexados à solicitação.` })
      : null;

    return elemento("div", {}, [
      elemento("section", { class: "flow-card" }, [
        elemento("div", { class: "flow-card-head" }, [
          elemento("h3", { text: "Confira antes de enviar" }),
          elemento("p", { text: "Depois do envio você recebe um protocolo para acompanhar." }),
        ]),
        dados,
        estado.documentos.length ? elemento("h4", { style: "margin:1.2rem 0 .4rem;font-size:.9rem", text: `Itens (${estado.documentos.length})` }) : null,
        itens,
        anexosResumo,
      ]),
      elemento("div", { class: "flow-acoes", style: "margin-top:1.2rem" }, [
        elemento("button", {
          class: "secondary-button", type: "button", text: "Voltar e ajustar",
          onclick: () => { estado.etapa = 2; render(); },
        }),
        elemento("button", {
          class: "primary-button", type: "button", text: "Enviar solicitação",
          id: "sol-enviar", onclick: enviar,
        }),
      ]),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Envio
  // ---------------------------------------------------------------------------
  function itensParaEnvio() {
    const tipo = estado.tipo;
    if (tipo.allows_documents && estado.documentos.length) return estado.documentos;

    // Sem lista de documentos, o item nasce do que a pessoa escreveu. É o que
    // permite registrar "só sei o título" ou "só tenho uma pergunta".
    const titulo = texto(estado.formulario.titulo_documento || estado.formulario.titulo_solicitado);
    const referencia = texto(estado.formulario.referencia);
    if (referencia) {
      const item = Docs.itemDeReferencia(referencia);
      if (titulo && !item.requested_title) item.requested_title = titulo;
      return [item];
    }
    if (titulo) return [Docs.itemDeTitulo(titulo, texto(estado.formulario.informacao_adicional))];
    return [];
  }

  function resumoDoPedido() {
    const tipo = estado.tipo;
    return texto(
      estado.formulario.titulo_documento
      || estado.formulario.titulo_solicitado
      || estado.formulario.pergunta
      || estado.formulario.referencia
      || estado.formulario.o_que_corrigir
      || estado.formulario.nome_profissional
      || `${tipo.label}${estado.documentos.length ? ` · ${estado.documentos.length} documento(s)` : ""}`
    ).slice(0, 300);
  }

  function descricaoDoPedido() {
    const partes = [];
    (estado.tipo.campos || []).forEach((campo) => {
      const valor = texto(estado.formulario[campo.field_key]);
      if (valor) partes.push(`${campo.label}: ${valor}`);
    });
    if (texto(estado.formulario._observacao)) partes.push(`Observações: ${texto(estado.formulario._observacao)}`);
    return partes.join("\n");
  }

  async function enviar() {
    if (estado.enviando) return;
    estado.enviando = true;
    const botao = document.getElementById("sol-enviar");
    if (botao) { botao.disabled = true; botao.textContent = "Registrando…"; }

    const formulario = {};
    (estado.tipo.campos || []).forEach((campo) => {
      const valor = estado.formulario[campo.field_key];
      if (valor !== undefined && valor !== "") formulario[campo.field_key] = valor;
    });
    if (texto(estado.formulario._observacao)) formulario.observacoes = texto(estado.formulario._observacao);

    const { data, error } = await Api.solicitacoes.criar({
      tipo: estado.tipo.code,
      nome: estado.formulario._nome,
      area: estado.formulario._area,
      contato: estado.formulario._contato,
      resumo: resumoDoPedido(),
      descricao: descricaoDoPedido(),
      formulario,
      itens: itensParaEnvio(),
    });

    if (error) {
      estado.enviando = false;
      if (botao) { botao.disabled = false; botao.textContent = "Enviar solicitação"; }
      avisar(error, "erro");
      return;
    }

    // A solicitação já está registrada. O que vem depois é acabamento: se
    // falhar, o pedido continua de pé e a equipe resolve pelo painel.
    mostrarRecibo(data);

    const pendencias = [];
    if (estado.anexos.length) {
      pendencias.push((async () => {
        for (const arquivo of estado.anexos) {
          const resultado = await Api.anexos.enviar(data.id, arquivo);
          if (resultado.error) console.warn("[GRCON Flow] anexo não enviado:", arquivo.name, resultado.error);
        }
      })());
    }
    if (data.uses_ld) pendencias.push(Api.triagem.solicitacao(data.id));

    await Promise.allSettled(pendencias);
    const aviso = document.getElementById("sol-pos-envio");
    if (aviso) {
      aviso.className = "flow-aviso ok";
      aviso.textContent = data.uses_ld
        ? "Triagem concluída. A equipe já vê o resultado no painel."
        : "Pedido encaminhado para a equipe.";
    }
  }

  function mostrarRecibo(resultado) {
    estado.enviando = false;
    const conteudo = elemento("div", { class: "flow-card" }, [
      elemento("div", { class: "flow-recibo" }, [
        elemento("div", { class: "flow-recibo-selo", "aria-hidden": "true", text: "✓" }),
        elemento("h2", { text: "Solicitação registrada" }),
        elemento("p", { text: "Guarde o protocolo abaixo para acompanhar o andamento." }),
        elemento("div", { class: "flow-protocolo", text: resultado.protocol }),
        elemento("p", { style: "font-size:.85rem;color:var(--text-3)", text:
          `${estado.tipo.label} · ${resultado.items} item(ns)` }),
        elemento("p", {
          class: "flow-carregando", id: "sol-pos-envio",
          text: resultado.uses_ld ? "Consultando as LDs vigentes…" : "Encaminhando para a equipe…",
        }),
        elemento("div", { class: "flow-acoes", style: "justify-content:center;margin-top:1.2rem" }, [
          elemento("a", { class: "primary-button", href: `/acompanhar?protocolo=${encodeURIComponent(resultado.protocol)}`, text: "Acompanhar esta solicitação" }),
          elemento("button", {
            class: "secondary-button", type: "button", text: "Fazer outra solicitação",
            onclick: () => {
              estado.tipo = null; estado.etapa = 1;
              estado.documentos = []; estado.anexos = []; estado.formulario = {};
              render();
            },
          }),
        ]),
      ]),
    ]);
    document.getElementById("sol-conteudo").replaceChildren(conteudo);
    document.getElementById("sol-etapas").replaceChildren();
    root.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ---------------------------------------------------------------------------
  function render() {
    const conteudo = document.getElementById("sol-conteudo");
    const etapas = document.getElementById("sol-etapas");
    if (!conteudo) { montarPagina(); return; }
    etapas.replaceChildren(montarEtapas());
    conteudo.replaceChildren(
      estado.etapa === 1 ? montarEscolha()
        : estado.etapa === 2 ? montarFormulario()
        : montarConferencia()
    );
  }

  function montarPagina() {
    app.replaceChildren(
      root.FlowUi.montarTopo({ ativo: "solicitar", subtitulo: "Nova solicitação" }),
      elemento("main", { class: "flow-main estreito" }, [
        elemento("div", { class: "flow-page-head" }, [
          elemento("h1", { text: "Nova solicitação" }),
          elemento("p", { text: "Informe apenas o que você sabe. O GRCON Flow cuida da pesquisa nas bases." }),
        ]),
        elemento("div", { id: "sol-etapas" }),
        elemento("div", { id: "sol-conteudo" }),
      ]),
      root.FlowUi.montarRodape()
    );
    render();
  }

  (async function iniciar() {
    const perfil = await root.FlowUi.exigirSessao();
    if (!perfil) return;

    const { data, error } = await Api.tipos.listar();
    if (error) { avisar(error, "erro"); return; }
    if (!data.length) {
      app.replaceChildren(
        root.FlowUi.montarTopo({ ativo: "solicitar" }),
        elemento("main", { class: "flow-main estreito" }, [
          elemento("div", { class: "flow-aviso atencao", text:
            "Nenhum tipo de solicitação está ativo. Peça a um administrador para cadastrar os tipos no painel." }),
        ])
      );
      return;
    }
    estado.tipos = data;
    montarPagina();
  })();
})(window);
