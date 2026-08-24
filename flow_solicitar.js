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
    paresN1710: {},
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
          estado.paresN1710 = {};
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
        elemento("h2", { text: "O que você precisa?" }),
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

  // LI e MC são documentos N-1710 que sempre chegam em duas representações
  // do mesmo item: PDF + Excel. O par fica fora do objeto que vai ao banco até
  // a solicitação nascer, porque o item_id só existe depois do protocolo.
  function codigoLiMcN1710(item) {
    const codigo = texto(item && item.document).toUpperCase();
    return /^(LI|MC)-/.test(codigo) ? codigo : "";
  }

  function extensaoArquivo(arquivo) {
    return texto(arquivo && arquivo.name).toLowerCase().split(".").pop();
  }

  function parN1710(item, criar = true) {
    const chave = codigoLiMcN1710(item);
    if (!chave) return null;
    if (!estado.paresN1710[chave] && criar) estado.paresN1710[chave] = { pdf: null, excel: null };
    return estado.paresN1710[chave] || null;
  }

  function moverParN1710(chaveAnterior, itemNovo) {
    const chaveNova = codigoLiMcN1710(itemNovo);
    if (!chaveAnterior || chaveAnterior === chaveNova) return;
    const existente = estado.paresN1710[chaveAnterior];
    delete estado.paresN1710[chaveAnterior];
    if (existente && chaveNova) estado.paresN1710[chaveNova] = existente;
  }

  function receberArquivoN1710(item, formato, arquivo) {
    if (!arquivo) return;
    const erro = Api.anexos.validar(arquivo);
    if (erro) { avisar(erro, "erro"); return; }
    const extensao = extensaoArquivo(arquivo);
    const compativel = formato === "pdf"
      ? extensao === "pdf"
      : ["xls", "xlsx", "xlsm"].includes(extensao);
    if (!compativel) {
      avisar(formato === "pdf"
        ? "Selecione o arquivo PDF deste LI/MC."
        : "Selecione a planilha Excel (.xls, .xlsx ou .xlsm) deste LI/MC.", "erro");
      return;
    }
    const par = parN1710(item);
    if (!par) return;
    par[formato] = arquivo;
    render();
  }

  function montarParN1710(item) {
    const codigo = codigoLiMcN1710(item);
    if (!codigo) return null;
    const par = parN1710(item);
    const slot = (formato, rotulo, accept) => {
      const arquivo = par[formato];
      const input = elemento("input", { type: "file", accept, hidden: true });
      input.addEventListener("change", () => {
        receberArquivoN1710(item, formato, input.files && input.files[0]);
        input.value = "";
      });
      return elemento("div", {
        style: "display:flex;gap:.55rem;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:.55rem .65rem;border:1px solid var(--line);border-radius:.55rem;background:var(--surface);",
      }, [
        elemento("div", { style: "min-width:12rem;flex:1" }, [
          elemento("strong", { style: "display:block;font-size:.82rem", text: rotulo }),
          elemento("small", { text: arquivo ? `${arquivo.name} · ${tamanhoArquivo(arquivo.size)}` : "Obrigatório para GRDT/postagem" }),
        ]),
        elemento("div", { class: "flow-acoes", style: "margin:0;gap:.35rem" }, [
          elemento("button", {
            class: arquivo ? "secondary-button compact" : "primary-button compact",
            type: "button", text: arquivo ? "Trocar" : "Selecionar", onclick: () => input.click(),
          }),
          arquivo ? elemento("button", {
            class: "text-button danger", type: "button", text: "Remover",
            onclick: () => { par[formato] = null; render(); },
          }) : null,
          input,
        ]),
      ]);
    };

    const completo = Boolean(par.pdf && par.excel);
    return elemento("div", {
      class: `flow-aviso ${completo ? "ok" : "atencao"}`,
      style: "margin:.55rem 0 .2rem 2.6rem;display:grid;gap:.5rem",
    }, [
      elemento("div", {}, [
        elemento("strong", { text: `${codigo} · conjunto N-1710` }),
        elemento("p", { style: "margin:.15rem 0 0", text: completo
          ? "PDF e Excel selecionados. Os dois serão vinculados a este documento."
          : "Para LI ou MC, envie o PDF e o Excel do mesmo documento. Os dois são obrigatórios antes da GRDT/postagem." }),
      ]),
      slot("pdf", "Arquivo PDF", ".pdf"),
      slot("excel", "Arquivo Excel", ".xls,.xlsx,.xlsm"),
    ]);
  }

  /** Entrada documental. Para Postagem no SIGEM, título é suficiente e código é opcional. */
  function montarDocumentos() {
    const tipo = estado.tipo;
    const postagem = tipo.code === "POSTAGEM_SIGEM";
    const bloco = elemento("section", { class: "flow-card" });

    bloco.append(elemento("div", { class: "flow-card-head" }, [
      elemento("h3", { text: postagem ? "Documentos para postagem" : "Documentos" }),
      elemento("p", { text: postagem
        ? "Informe o que precisa ser postado. Se ainda não houver código, coloque somente o título — a equipe fará a identificação, inclusão na LD e alocação antes da postagem."
        : (tipo.requires_document ? "Cole um ou mais códigos, um por linha." : "Se não souber o código, siga sem preencher.") }),
    ]));

    if (postagem) {
      const codigo = elemento("input", { id: "sol-novo-codigo", type: "text", autocomplete: "off", placeholder: "Código, se souber (opcional)" });
      const titulo = elemento("input", { id: "sol-novo-titulo", type: "text", autocomplete: "off", placeholder: "Título ou descrição do documento" });
      const adicionar = () => {
        const cod = texto(codigo.value);
        const tit = texto(titulo.value);
        if (!cod && !tit) { avisar("Informe pelo menos o título ou o código do documento.", "erro"); return; }
        const item = cod ? Docs.itemDeCodigo(cod, { titulo: tit }) : Docs.itemDeTitulo(tit, "");
        acrescentar([item]);
      };
      codigo.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); adicionar(); } });
      titulo.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); adicionar(); } });

      bloco.append(elemento("div", { class: "flow-doc-add" }, [
        elemento("label", { class: "flow-campo", for: "sol-novo-titulo" }, [
          elemento("span", { text: "Título do documento" }),
          elemento("small", { text: "Pode ser o nome que você conhece hoje; não precisa estar no padrão da LD." }),
          titulo,
        ]),
        elemento("label", { class: "flow-campo", for: "sol-novo-codigo" }, [
          elemento("span", { text: "Código do documento (opcional)" }),
          elemento("small", { text: "Deixe vazio quando o documento for novo ou quando você não souber o código." }),
          codigo,
        ]),
        elemento("button", { class: "secondary-button", type: "button", text: "Adicionar documento", onclick: adicionar }),
      ]));

      const colar = elemento("textarea", {
        id: "sol-colar", rows: "4", placeholder:
          "Cole vários títulos, um por linha. Também aceitamos CÓDIGO + TAB + TÍTULO.\nRelatório de inspeção da válvula VM-0001\n5290.00-22313-142-C1O-002\tMemória de cálculo...",
      });
      bloco.append(elemento("details", { class: "flow-lote" }, [
        elemento("summary", { text: "Adicionar vários de uma vez" }),
        elemento("label", { class: "flow-campo", for: "sol-colar" }, [
          elemento("span", { text: "Lista de títulos/códigos" }),
          elemento("small", { text: "Uma linha por documento. Título sozinho é válido; código não é obrigatório." }),
          colar,
        ]),
        elemento("button", {
          class: "secondary-button compact", type: "button", text: "Adicionar lista",
          onclick: () => {
            const novos = Docs.daListaFlexivel(colar.value);
            if (!novos.length) { avisar("Nenhum documento informado na lista.", "erro"); return; }
            acrescentar(novos);
            colar.value = "";
          },
        }),
      ]));
    } else {
      const colar = elemento("textarea", {
        id: "sol-colar", rows: "3", placeholder:
          "Cole os códigos, um por linha.\nC1O_RNEST_U32_3.1.1.1_INS_RIR_SPE-AST-320019\n5290.00-22313-91A-C1O-004",
      });
      bloco.append(elemento("label", { class: "flow-campo", for: "sol-colar" }, [
        elemento("span", { text: "Lista de códigos" }), colar,
      ]), elemento("button", {
        class: "secondary-button compact", type: "button", text: "Acrescentar da lista",
        onclick: () => {
          const novos = Docs.daListaColada(colar.value);
          if (!novos.length) { avisar("Nenhum código reconhecido no texto colado.", "erro"); return; }
          acrescentar(novos); colar.value = "";
        },
      }));
    }

    const contagem = elemento("span", { class: "flow-carregando", id: "sol-contagem", style: "padding:0;font-size:.78rem" });
    const lista = elemento("div", { class: "flow-itens", id: "sol-lista" });
    bloco.append(contagem, lista);
    desenharLista(lista, contagem, postagem);
    return bloco;
  }

  function tamanhoArquivo(bytes) {
    const tamanho = Number(bytes) || 0;
    if (tamanho < 1024 * 1024) return `${Math.max(1, Math.round(tamanho / 1024))} KB`;
    return `${(tamanho / (1024 * 1024)).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
  }

  /** Anexos são independentes dos códigos e ficam disponíveis em todo pedido. */
  function montarAnexos() {
    const maximo = Api.anexos.maximo || 5;
    const limiteAtingido = estado.anexos.length >= maximo;
    const entradaArquivos = elemento("input", {
      type: "file", multiple: true, hidden: true, id: "sol-arquivos",
      accept: Api.anexos.accept, disabled: limiteAtingido || null,
    });
    const area = elemento("div", {
      class: `flow-drop ${limiteAtingido ? "cheio" : ""}`, tabindex: limiteAtingido ? "-1" : "0", role: "button",
      "aria-disabled": limiteAtingido ? "true" : "false",
      "aria-label": `Escolher ou arrastar anexos em ${Api.anexos.formatos}`,
      onclick: () => {
        if (limiteAtingido) { avisar(`O limite é de ${maximo} anexos por solicitação.`); return; }
        entradaArquivos.click();
      },
      onkeydown: (evento) => {
        if (!limiteAtingido && (evento.key === "Enter" || evento.key === " ")) {
          evento.preventDefault(); entradaArquivos.click();
        }
      },
    }, [
      icone("upload"),
      elemento("strong", { text: limiteAtingido ? "Limite de anexos atingido" : "Arraste os anexos aqui" }),
      elemento("span", { text: `${Api.anexos.formatos} · até ${maximo} arquivos · ${Api.config.uploadMaxMb || 10} MB cada.` }),
      entradaArquivos,
    ]);

    ["dragenter", "dragover"].forEach((evento) => area.addEventListener(evento, (e) => {
      e.preventDefault(); area.classList.add("sobre");
    }));
    ["dragleave", "drop"].forEach((evento) => area.addEventListener(evento, (e) => {
      e.preventDefault(); area.classList.remove("sobre");
    }));
    area.addEventListener("drop", (evento) => receberArquivos(evento.dataTransfer.files));
    entradaArquivos.addEventListener("change", () => {
      receberArquivos(entradaArquivos.files);
      entradaArquivos.value = "";
    });

    const lista = elemento("div", { class: "flow-itens" });
    estado.anexos.forEach((arquivo, indice) => {
      const extensao = texto(arquivo.name).split(".").pop().toUpperCase();
      lista.append(elemento("div", { class: "flow-item" }, [
        elemento("span", { class: "flow-item-num", text: "📎" }),
        elemento("span", { class: "flow-item-corpo" }, [
          elemento("code", { text: arquivo.name }),
          elemento("em", { text: `${extensao} · ${tamanhoArquivo(arquivo.size)}` }),
        ]),
        elemento("button", {
          class: "text-button danger", type: "button", text: "Remover",
          "aria-label": `Remover anexo ${arquivo.name}`,
          onclick: () => { estado.anexos.splice(indice, 1); render(); },
        }),
      ]));
    });

    const temParN1710 = estado.documentos.some((item) => Boolean(codigoLiMcN1710(item)));
    return elemento("section", { class: "flow-card" }, [
      elemento("div", { class: "flow-card-head" }, [
        elemento("h3", { text: temParN1710 ? "Anexos complementares" : "Anexos" }),
        elemento("p", { text: temParN1710
          ? `${estado.anexos.length} de ${maximo} complementares selecionados. O PDF + Excel de LI/MC é enviado no próprio item acima.`
          : `${estado.anexos.length} de ${maximo} arquivos selecionados.` }),
      ]),
      area,
      estado.anexos.length ? lista : null,
    ]);
  }

  function receberArquivos(arquivos) {
    const lista = Array.from(arquivos || []);
    if (!lista.length) return;
    const maximo = Api.anexos.maximo || 5;
    const existentes = new Set(estado.anexos.map((arquivo) =>
      `${arquivo.name}\u0000${arquivo.size}\u0000${arquivo.lastModified || 0}`));
    const aceitos = [];
    const erros = [];
    lista.forEach((arquivo) => {
      const erro = Api.anexos.validar(arquivo);
      const chave = `${arquivo.name}\u0000${arquivo.size}\u0000${arquivo.lastModified || 0}`;
      if (erro) erros.push(erro);
      else if (existentes.has(chave)) erros.push(`“${arquivo.name}” já foi anexado.`);
      else if (estado.anexos.length + aceitos.length >= maximo) {
        erros.push(`O limite é de ${maximo} anexos por solicitação; “${arquivo.name}” não foi incluído.`);
      }
      else { existentes.add(chave); aceitos.push(arquivo); }
    });
    if (erros.length) avisar(erros.join(" "), "erro");
    if (!aceitos.length) return;
    estado.anexos = estado.anexos.concat(aceitos);

    // Nos tipos documentais, um código reconhecido no nome do arquivo também
    // entra na relação de itens; o arquivo continua sendo um anexo separado.
    if (estado.tipo && estado.tipo.allows_documents) {
      const extraidos = Docs.deArquivos(aceitos).filter((item) => item.document);
      const resultado = Docs.semRepetidos(estado.documentos.concat(extraidos));
      estado.documentos = resultado.itens;
      if (resultado.removidos.length) avisar(`${resultado.removidos.length} código(s) repetido(s) foram descartados.`);
    }
    render();
  }

  function acrescentar(novos) {
    const { itens, removidos } = Docs.semRepetidos(estado.documentos.concat(novos));
    estado.documentos = itens;
    if (removidos.length) avisar(`${removidos.length} código(s) repetido(s) foram descartados.`);
    render();
  }

  function desenharLista(destino, contagem, editavel = false) {
    destino.replaceChildren();
    if (contagem) {
      contagem.textContent = estado.documentos.length
        ? `${estado.documentos.length} documento(s) nesta solicitação`
        : "Nenhum documento adicionado ainda";
    }
    estado.documentos.forEach((item, indice) => {
      const semCodigo = !item.document;
      let corpo;
      if (editavel) {
        const titulo = elemento("input", { id: `sol-item-titulo-${indice}`, type: "text", value: item.requested_title || "", placeholder: "Título ou descrição do documento", "aria-label": `Título do documento ${indice + 1}` });
        const codigo = elemento("input", { id: `sol-item-codigo-${indice}`, type: "text", value: item.document || "", placeholder: "Código opcional", "aria-label": `Código do documento ${indice + 1}` });
        titulo.addEventListener("input", () => { estado.documentos[indice].requested_title = titulo.value; });
        codigo.addEventListener("change", () => {
          const atual = estado.documentos[indice];
          const chaveAnterior = codigoLiMcN1710(atual);
          const valor = texto(codigo.value);
          const itemNovo = valor
            ? Docs.itemDeCodigo(valor, { titulo: titulo.value, referencia: atual.reference, arquivo: atual.file_name })
            : { ...Docs.itemDeTitulo(titulo.value, atual.reference), file_name: atual.file_name || "" };
          moverParN1710(chaveAnterior, itemNovo);
          estado.documentos[indice] = itemNovo;
          render();
        });
        corpo = elemento("span", { class: "flow-item-corpo flow-item-edicao" }, [titulo, codigo]);
      } else {
        corpo = elemento("span", { class: "flow-item-corpo" }, [
          elemento("code", { text: item.document || "sem código — a equipe irá identificar" }),
          item.requested_title || item.file_name ? elemento("em", { text: item.requested_title || item.file_name }) : null,
        ]);
      }
      destino.append(elemento("div", { class: `flow-item ${semCodigo ? "flow-item-sem-codigo" : ""}` }, [
        elemento("span", { class: "flow-item-num", text: String(indice + 1).padStart(2, "0") }),
        corpo,
        elemento("button", {
          class: "text-button danger", type: "button", text: "Remover",
          "aria-label": `Remover item ${indice + 1}`,
          onclick: () => {
            const chave = codigoLiMcN1710(estado.documentos[indice]);
            if (chave) delete estado.paresN1710[chave];
            estado.documentos.splice(indice, 1);
            render();
          },
        }),
      ]));
      if (editavel && codigoLiMcN1710(item)) destino.append(montarParN1710(item));
    });
  }

  function montarFormulario() {
    const tipo = estado.tipo;
    const perfil = Api.auth.profile || {};
    const blocos = [];

    // Quem está pedindo. Vem preenchido do perfil: ninguém deveria digitar o
    // próprio nome toda vez.
    //
    // A equipe usa o mesmo formulário para lançar pedidos de quem ainda não tem
    // conta. Nesse caso os campos param de dizer "seus dados" e passam a
    // perguntar de quem é o pedido — o autor real fica no histórico.
    const equipe = Api.auth.ehEquipe();
    blocos.push(elemento("section", { class: "flow-card" }, [
      elemento("div", { class: "flow-card-head" }, [
        elemento("h3", { text: equipe ? "Dados do solicitante" : "Seus dados" }),
      ]),
      equipe ? elemento("div", { class: "flow-aviso ok", style: "margin-bottom:.85rem" }, [
        elemento("strong", { text: "Pedido em nome de outra pessoa" }),
        elemento("p", { style: "margin:.2rem 0 0", text:
          "Troque o nome, a área e o contato abaixo. A pessoa não precisa ter conta no GRCON Flow; seu usuário fica registrado no histórico como quem lançou a solicitação." }),
      ]) : null,
      elemento("div", { class: "flow-grid" }, [
        campoTexto("sol-nome", equipe ? "Nome do solicitante" : "Nome", {
          valor: estado.formulario._nome ?? (perfil.full_name || ""), obrigatorio: true,
        }),
        campoTexto("sol-area", "Área / setor", { valor: estado.formulario._area ?? (perfil.area || "") }),
        campoTexto("sol-contato", equipe ? "E-mail / contato do solicitante" : "Contato", {
          valor: estado.formulario._contato ?? (perfil.contact || perfil.email || ""),
          ajuda: equipe
            ? "Pode ser o e-mail de quem ainda não possui cadastro no aplicativo."
            : "E-mail ou ramal para retorno.",
        }),
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
        ]),
        grade,
      ]));
    }

    if (tipo.allows_documents) blocos.push(montarDocumentos());
    blocos.push(montarAnexos());

    // Observações. Sempre presente: é onde cabe o que o formulário não previu.
    blocos.push(elemento("section", { class: "flow-card" }, [
      elemento("div", { class: "flow-card-head" }, [
        elemento("h3", { text: "Observações" }),
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

  /**
   * Copia para o estado o que está escrito na tela. Precisa rodar antes de
   * qualquer redesenho da etapa 2: acrescentar um documento ou um anexo
   * reconstrói o formulário inteiro e, sem esta cópia, apagaria o nome, a área,
   * o contato, os campos do tipo e as observações que a pessoa acabou de
   * digitar.
   */
  function guardarFormulario() {
    if (!estado.tipo || !document.getElementById("sol-nome")) return;
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
    if (tipo.code === "POSTAGEM_SIGEM") {
      if (!estado.documentos.length) return "Adicione pelo menos um documento para postagem. O código pode ficar em branco.";
      const vazio = estado.documentos.find((item) => !texto(item.document) && !texto(item.requested_title));
      if (vazio) return "Todo item precisa ter pelo menos um título/descrição ou um código.";
      for (const item of estado.documentos) {
        const codigo = codigoLiMcN1710(item);
        if (!codigo) continue;
        const par = parN1710(item, false);
        if (!par || !par.pdf || !par.excel) {
          const faltam = [!par || !par.pdf ? "PDF" : "", !par || !par.excel ? "Excel" : ""].filter(Boolean).join(" e ");
          return `${codigo} é LI/MC da N-1710. Anexe o ${faltam} obrigatório(s) antes de continuar.`;
        }
      }
    } else if (tipo.requires_document && !estado.documentos.length) {
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

    const paresObrigatorios = estado.documentos.filter((item) => Boolean(codigoLiMcN1710(item)));
    const totalArquivosObrigatorios = paresObrigatorios.length * 2;
    const anexosResumo = estado.anexos.length
      ? elemento("p", { class: "flow-aviso", text: `${estado.anexos.length} arquivo(s) complementar(es) serão anexados à solicitação.` })
      : null;
    const paresResumo = totalArquivosObrigatorios
      ? elemento("p", { class: "flow-aviso ok", text: `${paresObrigatorios.length} item(ns) LI/MC da N-1710 · ${totalArquivosObrigatorios} arquivos obrigatórios (PDF + Excel) serão enviados e vinculados aos documentos corretos.` })
      : null;

    return elemento("div", {}, [
      elemento("section", { class: "flow-card" }, [
        elemento("div", { class: "flow-card-head" }, [
          elemento("h3", { text: "Confira antes de enviar" }),
        ]),
        dados,
        estado.documentos.length ? elemento("h4", { style: "margin:1.2rem 0 .4rem;font-size:.9rem", text: `Itens (${estado.documentos.length})` }) : null,
        itens,
        paresResumo,
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

  function prepararAnexosParaEnvio(resultadoCriacao) {
    const entradas = estado.anexos.map((arquivo) => ({
      arquivo, itemId: null, rotulo: `Anexo complementar · ${arquivo.name}`,
    }));
    const itensCriados = Array.isArray(resultadoCriacao && resultadoCriacao.request_items)
      ? resultadoCriacao.request_items : [];

    estado.documentos.forEach((item, indice) => {
      const codigo = codigoLiMcN1710(item);
      if (!codigo) return;
      const par = parN1710(item, false);
      const criado = itensCriados.find((registro) => Number(registro.item_number) === indice + 1);
      if (!criado || !criado.id) {
        entradas.push({ arquivo: par && par.pdf, itemId: null, rotulo: `${codigo} · PDF`, erroPreparacao: "Não foi possível vincular o PDF ao item criado." });
        entradas.push({ arquivo: par && par.excel, itemId: null, rotulo: `${codigo} · Excel`, erroPreparacao: "Não foi possível vincular o Excel ao item criado." });
        return;
      }
      entradas.push({ arquivo: par.pdf, itemId: criado.id, rotulo: `${codigo} · PDF` });
      entradas.push({ arquivo: par.excel, itemId: criado.id, rotulo: `${codigo} · Excel` });
    });
    return entradas.filter((entrada) => entrada.arquivo || entrada.erroPreparacao);
  }

  async function enviarAnexos(requestId, entradas) {
    const resultado = { enviados: [], falhas: [] };
    for (let indice = 0; indice < entradas.length; indice += 1) {
      const entrada = entradas[indice] && entradas[indice].arquivo
        ? entradas[indice]
        : { arquivo: entradas[indice], itemId: null, rotulo: texto(entradas[indice] && entradas[indice].name) };
      const arquivo = entrada.arquivo;
      if (entrada.erroPreparacao || !arquivo) {
        resultado.falhas.push({ ...entrada, erro: entrada.erroPreparacao || "Arquivo obrigatório ausente." });
        continue;
      }
      const andamento = document.getElementById("sol-anexos-envio");
      if (andamento) {
        andamento.className = "flow-carregando";
        andamento.replaceChildren();
        andamento.textContent = `Enviando ${indice + 1} de ${entradas.length}: ${entrada.rotulo || arquivo.name}`;
      }
      const retorno = await Api.anexos.enviar(requestId, arquivo, entrada.itemId || null);
      if (retorno.error) resultado.falhas.push({ ...entrada, erro: retorno.error });
      else resultado.enviados.push(entrada);
    }
    return resultado;
  }

  function mostrarResultadoAnexos(requestId, resultado) {
    const destino = document.getElementById("sol-anexos-envio");
    if (!destino) return;
    destino.replaceChildren();

    if (!resultado.falhas.length) {
      destino.className = "flow-aviso ok";
      destino.textContent = `${resultado.enviados.length} arquivo(s) enviado(s) com sucesso.`;
      return;
    }

    destino.className = "flow-aviso atencao";
    destino.append(
      elemento("strong", { text: `${resultado.enviados.length} arquivo(s) enviado(s); ${resultado.falhas.length} falharam.` }),
      elemento("p", { text: "A solicitação foi registrada. Os itens LI/MC que ainda não tiverem PDF + Excel ficam bloqueados antes da GRDT/postagem até o reenvio dar certo." }),
      elemento("ul", {}, resultado.falhas.map(({ arquivo, rotulo, erro }) =>
        elemento("li", { text: `${rotulo || (arquivo && arquivo.name) || "Arquivo"}: ${erro}` })))
    );
    destino.append(elemento("button", {
      class: "secondary-button compact", type: "button", text: "Tentar anexos novamente",
      onclick: async (evento) => {
        evento.currentTarget.disabled = true;
        const pendentes = resultado.falhas.map(({ erro, ...entrada }) => entrada);
        const novaTentativa = await enviarAnexos(requestId, pendentes);
        resultado.enviados.push(...novaTentativa.enviados);
        resultado.falhas = novaTentativa.falhas;
        mostrarResultadoAnexos(requestId, resultado);
      },
    }));
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

    // Primeiro sobe os arquivos. Para LI/MC, o PDF e o Excel são vinculados ao
    // item correto e só então a triagem define a próxima ação da equipe.
    const arquivos = prepararAnexosParaEnvio(data);
    mostrarRecibo(data, arquivos.length);
    const resultadoAnexos = arquivos.length
      ? await enviarAnexos(data.id, arquivos)
      : { enviados: [], falhas: [] };
    if (arquivos.length) mostrarResultadoAnexos(data.id, resultadoAnexos);
    const triagem = data.uses_ld
      ? await Api.triagem.solicitacao(data.id)
      : { data: null, error: null };

    const aviso = document.getElementById("sol-pos-envio");
    if (aviso) {
      aviso.className = triagem.error ? "flow-aviso atencao" : "flow-aviso ok";
      aviso.textContent = triagem.error
        ? `Pedido encaminhado, mas a triagem automática não terminou: ${triagem.error}`
        : data.uses_ld
          ? "Triagem concluída. A equipe já vê o resultado no painel."
          : "Pedido encaminhado para a equipe.";
    }
  }

  function mostrarRecibo(resultado, quantidadeAnexos = 0) {
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
        quantidadeAnexos ? elemento("div", {
          class: "flow-carregando", id: "sol-anexos-envio",
          text: `Preparando ${quantidadeAnexos} anexo(s)…`,
        }) : null,
        elemento("div", { class: "flow-acoes", style: "justify-content:center;margin-top:1.2rem" }, [
          elemento("a", { class: "primary-button", href: `/acompanhar?protocolo=${encodeURIComponent(resultado.protocol)}`, text: "Acompanhar esta solicitação" }),
          elemento("button", {
            class: "secondary-button", type: "button", text: "Fazer outra solicitação",
            onclick: () => {
              estado.tipo = null; estado.etapa = 1;
              estado.documentos = []; estado.anexos = []; estado.paresN1710 = {}; estado.formulario = {};
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
  /** Onde estava o cursor, para devolvê-lo depois do redesenho. */
  function marcarFoco() {
    const ativo = document.activeElement;
    if (!ativo || !ativo.id || ativo === document.body) return null;
    const selecionavel = typeof ativo.setSelectionRange === "function";
    return {
      id: ativo.id,
      inicio: selecionavel ? ativo.selectionStart : null,
      fim: selecionavel ? ativo.selectionEnd : null,
    };
  }

  function devolverFoco(marca) {
    if (!marca) return;
    const node = document.getElementById(marca.id);
    if (!node || typeof node.focus !== "function") return;
    node.focus();
    if (marca.inicio === null || typeof node.setSelectionRange !== "function") return;
    // Campo de data, cor e afins recusam seleção; o foco já basta.
    try { node.setSelectionRange(marca.inicio, marca.fim); } catch (erro) { /* sem seleção */ }
  }

  function render() {
    const conteudo = document.getElementById("sol-conteudo");
    const etapas = document.getElementById("sol-etapas");
    if (!conteudo) { montarPagina(); return; }
    if (estado.etapa === 2) guardarFormulario();
    const foco = marcarFoco();
    etapas.replaceChildren(montarEtapas());
    conteudo.replaceChildren(
      estado.etapa === 1 ? montarEscolha()
        : estado.etapa === 2 ? montarFormulario()
        : montarConferencia()
    );
    devolverFoco(foco);
  }

  function montarPagina() {
    app.replaceChildren(
      root.FlowUi.montarTopo({ ativo: "solicitar", subtitulo: "Nova solicitação" }),
      elemento("main", { class: "flow-main estreito" }, [
        elemento("div", { class: "flow-page-head" }, [
          elemento("h1", { text: "Nova solicitação" }),
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
    // Quem chegou aqui recusado em outra área lê o motivo agora.
    root.FlowUi.avisoDaUrl();
  })();
})(window);
