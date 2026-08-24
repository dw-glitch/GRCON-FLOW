/**
 * GRCON Flow — Base Documental.
 *
 * As LDs vivem dentro do Flow. O solicitante nunca anexa uma: o administrador
 * publica a revisão do dia aqui e todas as triagens seguintes já a usam.
 *
 * Publicar uma revisão nova não apaga a anterior. A versão antiga fica
 * inativa, e cada triagem guarda qual versão usou — é o que permite explicar,
 * meses depois, por que uma análise respondeu o que respondeu.
 */
(function (root) {
  "use strict";

  const Ui = root.FlowUi;
  const { elemento, avisar, texto, dataHora } = Ui;
  const Api = root.FlowApi;
  const Docs = root.FlowDocs;

  // Um lote por requisição. A planilha inteira numa chamada só estouraria o
  // limite de tamanho do PostgREST e derrubaria a atualização no meio.
  const TAMANHO_DO_LOTE = 500;

  const estado = { lds: [], destino: null, enviando: false };

  function selo(status) {
    const mapa = {
      ativa: { classe: "pronto", rotulo: "Ativa" },
      pronta: { classe: "candidatos", rotulo: "Pronta para ativar" },
      inativa: { classe: "neutro", rotulo: "Inativa" },
      processando: { classe: "candidatos", rotulo: "Processando" },
      erro: { classe: "nao-localizado", rotulo: "Falhou" },
    };
    const info = mapa[status] || mapa.inativa;
    return elemento("span", { class: `flow-selo ${info.classe}`, text: info.rotulo });
  }

  // ---------------------------------------------------------------------------
  // Envio de uma revisão
  // ---------------------------------------------------------------------------
  function impedirSaida(evento) {
    evento.preventDefault();
    evento.returnValue = "";
    return "";
  }

  async function enviarRevisao(ld, arquivo, revisao, analise, progresso) {
    const limite = (Api.config.ldUploadMaxMb || 100) * 1024 * 1024;
    if (arquivo.size > limite) {
      throw new Error(`O arquivo tem mais de ${Api.config.ldUploadMaxMb || 100} MB.`);
    }

    if (!analise || !analise.podePublicar) {
      throw new Error("Analise e aprove a planilha antes de publicar.");
    }
    if (!analise.documentos.length) {
      throw new Error("Nenhum documento foi reconhecido nesta planilha. Confira se é a LD correta.");
    }

    progresso(`${analise.documentos.length.toLocaleString("pt-BR")} documentos aprovados. Criando a versão…`, 12);
    const { data: versao, error: erroVersao } = await Api.lds.criarVersao(
      ld.id, arquivo, revisao || analise.ldVersion, analise
    );
    if (erroVersao) throw new Error(erroVersao);

    try {
      // Sem o original não existe trilha de auditoria. Uma falha no Storage
      // interrompe a publicação antes de tornar a revisão vigente.
      const guardado = await Api.lds.guardarArquivo(versao.id, arquivo);
      if (guardado.error) throw new Error(guardado.error);

      let enviados = 0;
      for (let inicio = 0; inicio < analise.documentos.length; inicio += TAMANHO_DO_LOTE) {
        const lote = analise.documentos.slice(inicio, inicio + TAMANHO_DO_LOTE);
        const { error } = await Api.lds.enviarLote(versao.id, lote);
        if (error) throw new Error(error);
        enviados += lote.length;
        const proporcao = 15 + Math.round((enviados / analise.documentos.length) * 70);
        progresso(`Indexando ${enviados.toLocaleString("pt-BR")} de ${analise.documentos.length.toLocaleString("pt-BR")}…`, proporcao);
      }

      progresso("Conferindo a indexação…", 90);
      const { error: erroFinalizar } = await Api.lds.finalizarVersao(versao.id, analise.relatorio);
      if (erroFinalizar) throw new Error(erroFinalizar);

      progresso("Ativando a nova versão…", 96);
      const { error: erroAtivar } = await Api.lds.ativarVersao(versao.id);
      if (erroAtivar) throw new Error(erroAtivar);

      progresso("Concluído.", 100);
      return { documentos: enviados, abas: analise.abas };
    } catch (erro) {
      // Versão que falhou fica marcada como tal, em vez de sumir: quem tentou
      // atualizar precisa ver que não deu certo, e por quê.
      await Api.lds.marcarErro(versao.id, erro.message || String(erro));
      throw erro;
    }
  }

  function abrirEnvio(ld) {
    const entrada = elemento("input", { type: "file", accept: ".xlsx,.xls,.xlsm", id: `ld-arquivo-${ld.id}` });
    const revisao = elemento("input", { type: "text", id: `ld-rev-${ld.id}`, placeholder: "Ex.: E", autocomplete: "off" });
    const situacao = elemento("p", { class: "flow-carregando", style: "padding:.5rem 0;justify-content:flex-start", hidden: true });
    const barra = elemento("div", { class: "flow-barra-progresso", hidden: true }, [elemento("i", { style: "width:0%" })]);
    const abas = elemento("div", { class: "flow-abas-importacao", hidden: true });
    const previa = elemento("div", { class: "flow-previa-ld", hidden: true });
    const resolver = elemento("input", { type: "checkbox", id: `ld-resolver-${ld.id}` });
    const aceitarAlertas = elemento("input", { type: "checkbox", id: `ld-alertas-${ld.id}` });
    let fonte = null;
    let analise = null;
    let regras = {};

    const progresso = (mensagem, proporcao) => {
      situacao.hidden = false;
      barra.hidden = false;
      situacao.replaceChildren(
        proporcao < 100 ? elemento("span", { class: "flow-spin", "aria-hidden": "true" }) : document.createTextNode("✓ "),
        document.createTextNode(mensagem)
      );
      barra.querySelector("i").style.width = `${proporcao}%`;
    };

    const publicar = elemento("button", {
      class: "primary-button", type: "button", text: "Publicar revisão", disabled: true,
      onclick: async () => {
        const arquivo = entrada.files && entrada.files[0];
        if (!arquivo) { avisar("Escolha o arquivo da LD.", "erro"); return; }
        if (!analise || !analise.podePublicar) { avisar("A pré-análise ainda possui bloqueios.", "erro"); return; }
        if (analise.alertasCodigo.length && !aceitarAlertas.checked) {
          avisar("Confirme que os alertas de codificação foram revisados.", "erro"); return;
        }
        if (estado.enviando) return;
        estado.enviando = true;
        publicar.disabled = true;
        // Indexar uma LD são dezenas de lotes. Fechar a aba no meio deixa a
        // versão parada em "processando", sem ninguém para retomá-la — por isso
        // o navegador pergunta antes de deixar a página.
        root.addEventListener("beforeunload", impedirSaida);
        try {
          const resultado = await enviarRevisao(ld, arquivo, revisao.value, analise, progresso);
          avisar(`${ld.code} atualizada: ${resultado.documentos.toLocaleString("pt-BR")} documentos indexados.`, "ok");
          await carregar();
        } catch (erro) {
          progresso(erro.message || "Falhou.", 100);
          avisar(erro.message || "Não foi possível atualizar a LD.", "erro");
        } finally {
          root.removeEventListener("beforeunload", impedirSaida);
          estado.enviando = false;
          validarPublicacao();
        }
      },
    });

    function validarPublicacao() {
      publicar.disabled = estado.enviando || !analise || !analise.podePublicar
        || (analise.alertasCodigo.length > 0 && !aceitarAlertas.checked);
    }

    function resumoNumero(rotulo, valor, classe = "") {
      return elemento("div", { class: `flow-resumo-numero ${classe}`.trim() }, [
        elemento("strong", { text: Number(valor || 0).toLocaleString("pt-BR") }),
        elemento("span", { text: rotulo }),
      ]);
    }

    function renderizarPrevia() {
      if (!fonte) return;
      const selecionadas = [...abas.querySelectorAll("input[data-aba]:checked")].map((node) => node.value);
      analise = Docs.analisarFonteLd(fonte, {
        abasIncluidas: selecionadas,
        resolverConflitos: resolver.checked ? "linha_mais_recente" : "bloquear",
        regras,
      });
      const r = analise.relatorio;
      const blocos = [
        elemento("div", { class: "flow-resumo-importacao" }, [
          resumoNumero("linhas técnicas", r.technical_rows_read),
          resumoNumero("documentos únicos", r.unique_documents, analise.podePublicar ? "ok" : ""),
          resumoNumero("histórico excluído", r.history_rows_excluded),
          resumoNumero("duplicatas idênticas removidas", r.identical_duplicates_removed),
          resumoNumero("conflitos", r.conflicting_documents, r.conflicting_documents ? "alerta" : "ok"),
          resumoNumero("alertas de código", r.code_warnings, r.code_warnings ? "atencao" : "ok"),
        ]),
      ];
      if (analise.conflitos.length) {
        const amostra = analise.conflitos.slice(0, 8).map((item) =>
          `${item.document} — ${item.ocorrencias.map((o) => `${o.sheet}, linha ${o.row_number}`).join(" / ")}`);
        blocos.push(elemento("div", { class: "flow-aviso atencao" }, [
          elemento("strong", { text: "Linhas divergentes encontradas" }),
          elemento("p", { text: "O arquivo não será publicado enquanto a regra abaixo não for assumida explicitamente." }),
          elemento("ul", {}, amostra.map((item) => elemento("li", { text: item }))),
          analise.conflitos.length > amostra.length
            ? elemento("small", { text: `Mais ${(analise.conflitos.length - amostra.length).toLocaleString("pt-BR")} conflito(s) ficarão registrados no relatório da versão.` }) : null,
        ]));
        blocos.push(elemento("label", { class: "flow-confirmacao", for: resolver.id }, [
          resolver,
          elemento("span", { text: "Resolver os conflitos usando a última linha da aba técnica selecionada. Essa decisão ficará registrada na versão." }),
        ]));
      }
      if (analise.alertasCodigo.length) {
        const amostra = analise.alertasCodigo.slice(0, 8).map((item) =>
          `${item.document} — ${item.sheet}, linha ${item.row_number}: ${item.messages.join(" ")}`);
        blocos.push(elemento("div", { class: "flow-aviso atencao" }, [
          elemento("strong", { text: "Códigos que pedem conferência" }),
          elemento("ul", {}, amostra.map((item) => elemento("li", { text: item }))),
        ]));
        blocos.push(elemento("label", { class: "flow-confirmacao", for: aceitarAlertas.id }, [
          aceitarAlertas,
          elemento("span", { text: "Revisei os alertas de codificação e autorizo registrar esses documentos com a evidência indicada." }),
        ]));
      }
      if (analise.erros.length) {
        blocos.push(elemento("div", { class: "flow-aviso erro", text: analise.erros.join(" ") }));
      } else {
        blocos.push(elemento("div", { class: "flow-aviso ok", text:
          "Pré-análise concluída. Somente as abas técnicas marcadas serão indexadas; o histórico SIGEM não entra na triagem." }));
      }
      previa.hidden = false;
      previa.replaceChildren(...blocos);
      validarPublicacao();
    }

    resolver.addEventListener("change", renderizarPrevia);
    aceitarAlertas.addEventListener("change", validarPublicacao);

    async function analisarArquivo() {
      const arquivo = entrada.files && entrada.files[0];
      if (!arquivo) { avisar("Escolha o arquivo da LD.", "erro"); return; }
      const limite = (Api.config.ldUploadMaxMb || 100) * 1024 * 1024;
      if (arquivo.size > limite) { avisar(`O arquivo tem mais de ${Api.config.ldUploadMaxMb || 100} MB.`, "erro"); return; }
      publicar.disabled = true;
      previa.hidden = true;
      progresso("Lendo e classificando as abas…", 5);
      try {
        const regrasAtivas = Api.normas ? await Api.normas.regrasAtivas() : { data: {}, error: null };
        if (regrasAtivas.error) throw new Error(regrasAtivas.error);
        regras = regrasAtivas.data || {};
        fonte = await Docs.lerFonteLd(arquivo);
        if (!revisao.value && fonte.ldVersion) revisao.value = fonte.ldVersion;
        abas.hidden = false;
        abas.replaceChildren(
          elemento("strong", { text: "Abas encontradas" }),
          ...fonte.abas.map((aba) => {
            const check = elemento("input", {
              type: "checkbox", value: aba.nome, "data-aba": "1",
              disabled: aba.papel === "historico" || null,
            });
            check.checked = aba.selecionadaPorPadrao;
            check.addEventListener("change", renderizarPrevia);
            return elemento("label", { class: `flow-aba-importacao ${aba.papel}` }, [
              check,
              elemento("span", {}, [
                elemento("b", { text: aba.nome }),
                elemento("small", { text: [
                  `${aba.registros.toLocaleString("pt-BR")} linhas`,
                  aba.papel === "historico" ? "histórico — sempre excluído" : "técnica",
                  aba.oculta ? "oculta — exige seleção manual" : "visível",
                ].join(" · ") }),
              ]),
            ]);
          })
        );
        progresso("Pré-análise concluída.", 100);
        renderizarPrevia();
      } catch (erro) {
        fonte = null;
        analise = null;
        progresso(erro.message || "Não foi possível analisar a planilha.", 100);
        avisar(erro.message || "Não foi possível analisar a planilha.", "erro");
      }
    }

    entrada.addEventListener("change", () => {
      fonte = null;
      analise = null;
      abas.hidden = true;
      previa.hidden = true;
      validarPublicacao();
    });

    const analisar = elemento("button", {
      class: "secondary-button", type: "button", text: "Analisar arquivo",
      onclick: analisarArquivo,
    });

    return elemento("div", { class: "flow-card", style: "background:var(--surface-2);margin-top:.6rem" }, [
      elemento("div", { class: "flow-card-head" }, [
        elemento("h3", { text: `Publicar nova revisão de ${ld.code}` }),
        elemento("p", { text: "Primeiro o Flow separa as abas técnicas do histórico, consolida duplicidades e mostra os conflitos. Só depois a revisão pode ser publicada." }),
      ]),
      elemento("div", { class: "flow-grid" }, [
        elemento("label", { class: "flow-campo", for: entrada.id }, [
          elemento("span", { text: "Arquivo da LD" }),
          elemento("small", { text: ".xlsx, .xls ou .xlsm" }),
          entrada,
        ]),
        elemento("label", { class: "flow-campo", for: revisao.id }, [
          elemento("span", { text: "Revisão (opcional)" }),
          elemento("small", { text: "Se ficar em branco, usamos a que estiver na planilha." }),
          revisao,
        ]),
      ]),
      elemento("div", { class: "flow-acoes", style: "margin-top:.8rem" }, [analisar, publicar]),
      situacao, barra, abas, previa,
    ]);
  }

  // ---------------------------------------------------------------------------
  // Cadastro da LD
  // ---------------------------------------------------------------------------
  function formularioLd(ld = {}) {
    const codigo = elemento("input", { id: "ld-codigo", type: "text", placeholder: "LD_004", autocomplete: "off" });
    codigo.value = texto(ld.code);
    const nome = elemento("input", { id: "ld-nome", type: "text", placeholder: "Lista de Documentos — Unidade 32", autocomplete: "off" });
    nome.value = texto(ld.name);
    const descricao = elemento("input", { id: "ld-descricao", type: "text", autocomplete: "off" });
    descricao.value = texto(ld.description);

    return elemento("div", { class: "flow-card" }, [
      elemento("div", { class: "flow-card-head" }, [
        elemento("h3", { text: ld.id ? `Editar ${ld.code}` : "Cadastrar uma LD" }),
        elemento("p", { text: "O identificador é como a LD aparece nas triagens e nas exportações." }),
      ]),
      elemento("div", { class: "flow-grid" }, [
        elemento("label", { class: "flow-campo", for: "ld-codigo" }, [elemento("span", { text: "Identificador" }), codigo]),
        elemento("label", { class: "flow-campo", for: "ld-nome" }, [elemento("span", { text: "Nome" }), nome]),
        elemento("label", { class: "flow-campo larga", for: "ld-descricao" }, [elemento("span", { text: "Descrição" }), descricao]),
      ]),
      elemento("div", { class: "flow-acoes", style: "margin-top:.8rem" }, [
        elemento("button", {
          class: "primary-button", type: "button", text: ld.id ? "Salvar" : "Cadastrar",
          onclick: async () => {
            const { error } = await Api.lds.salvar({
              id: ld.id, code: codigo.value, name: nome.value, description: descricao.value,
              display_order: ld.display_order || estado.lds.length,
            });
            if (error) { avisar(error, "erro"); return; }
            avisar("Base documental atualizada.", "ok");
            await carregar();
          },
        }),
      ]),
    ]);
  }

  // ---------------------------------------------------------------------------
  function cartaoLd(ld) {
    const versoes = (ld.versoes || []).slice()
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const ativa = versoes.find((versao) => versao.status === "ativa");

    const historico = elemento("div", { class: "flow-itens" });
    versoes.slice(0, 8).forEach((versao) => {
      historico.append(elemento("div", { class: "flow-item" }, [
        elemento("span", { class: "flow-item-num" }, [selo(versao.status)]),
        elemento("span", { class: "flow-item-corpo" }, [
          elemento("code", { text: versao.file_name || "(sem arquivo)" }),
          elemento("em", { text: [
            versao.revision_label ? `Rev. ${versao.revision_label}` : "",
            `${(versao.document_count || 0).toLocaleString("pt-BR")} documentos`,
            dataHora(versao.created_at),
            versao.uploaded_by_name,
          ].filter(Boolean).join(" · ") }),
          versao.error_message
            ? elemento("em", { style: "color:#a83f35", text: versao.error_message })
            : null,
        ]),
        elemento("span", { class: "flow-acoes" }, [
          ["inativa", "pronta"].includes(versao.status) && versao.document_count > 0 ? elemento("button", {
            class: "text-button", type: "button", text: "Reativar",
            onclick: async () => {
              if (!await Ui.confirmar(`Voltar a usar esta versão de ${ld.code} nas triagens?`, {
                titulo: "Reativar versão", rotuloConfirmar: "Reativar",
                ajuda: "A versão vigente hoje passa a inativa, sem ser apagada.",
              })) return;
              const { error } = await Api.lds.ativarVersao(versao.id);
              if (error) { avisar(error, "erro"); return; }
              avisar("Versão reativada.", "ok");
              await carregar();
            },
          }) : null,
          versao.status !== "ativa" ? elemento("button", {
            class: "text-button danger", type: "button", text: "Excluir",
            onclick: async () => {
              if (!await Ui.confirmar("Excluir esta versão e os documentos indexados dela?", {
                titulo: "Excluir versão da LD", rotuloConfirmar: "Excluir", rotuloCancelar: "Manter", perigo: true,
                ajuda: "As triagens que a citam continuam registrando qual versão usaram.",
              })) return;
              const { error } = await Api.lds.removerVersao(versao.id);
              if (error) { avisar(error, "erro"); return; }
              avisar("Versão removida.", "ok");
              await carregar();
            },
          }) : null,
        ]),
      ]));
    });

    const area = elemento("div");

    return elemento("section", { class: "flow-card" }, [
      elemento("div", { style: "display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:flex-start" }, [
        elemento("div", {}, [
          elemento("h3", { style: "margin:0;font-size:1rem;color:var(--brand-strong)", text: ld.code }),
          elemento("p", { style: "margin:.1rem 0 0;font-size:.82rem;color:var(--text-3)", text: ld.name || ld.description || "" }),
          elemento("p", { style: "margin:.4rem 0 0;font-size:.82rem" },
            ativa
              ? [
                  elemento("span", { class: "flow-selo pronto", text: "Vigente" }),
                  ` ${(ativa.document_count || 0).toLocaleString("pt-BR")} documentos`,
                  ativa.revision_label ? ` · Rev. ${ativa.revision_label}` : "",
                  ` · atualizada em ${dataHora(ativa.activated_at || ativa.created_at)}`,
                ]
              : [elemento("span", { class: "flow-selo atencao", text: "Sem versão vigente" }),
                 " — publique uma revisão para que esta LD entre nas triagens."]
          ),
        ]),
        elemento("div", { class: "flow-acoes" }, [
          elemento("button", {
            class: "primary-button compact", type: "button", text: "Atualizar LD",
            onclick: () => {
              const aberto = area.firstChild;
              if (aberto) area.replaceChildren();
              else area.replaceChildren(abrirEnvio(ld));
            },
          }),
          elemento("button", {
            class: "text-button", type: "button", text: "Editar",
            onclick: () => area.replaceChildren(formularioLd(ld)),
          }),
        ]),
      ]),
      area,
      versoes.length
        ? elemento("div", { style: "margin-top:1rem" }, [
            elemento("h4", { style: "font-size:.82rem;color:var(--text-3);margin:0 0 .4rem", text: "Histórico de versões" }),
            historico,
          ])
        : null,
    ]);
  }

  async function carregar() {
    if (!estado.destino) return;
    Ui.carregando(estado.destino, "Carregando a Base Documental…");
    const { data, error } = await Api.lds.listar();
    if (error) { Ui.vazio(estado.destino, "Não foi possível carregar", error); return; }
    estado.lds = data || [];
    desenhar();
  }

  function desenhar() {
    const blocos = [
      elemento("div", { class: "flow-aviso", text:
        "As LDs vigentes são consultadas automaticamente por toda solicitação que informe um código. Publique aqui a revisão do dia — quantas vezes precisar." }),
    ];

    if (!estado.lds.length) {
      blocos.push(elemento("div", { class: "flow-vazio" }, [
        elemento("strong", { text: "Nenhuma LD cadastrada" }),
        elemento("span", { text: "Cadastre a primeira abaixo e depois publique a revisão vigente." }),
      ]));
    } else {
      estado.lds.forEach((ld) => blocos.push(cartaoLd(ld)));
    }

    blocos.push(formularioLd());
    estado.destino.replaceChildren(...blocos);
  }

  function montar(destino) {
    estado.destino = destino;
    carregar();
  }

  root.FlowLd = Object.freeze({ montar });
})(window);
