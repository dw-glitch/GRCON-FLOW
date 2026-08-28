/**
 * GRCON Flow — camada de dados.
 *
 * Tudo o que a interface sabe sobre o banco passa por aqui. As telas nunca
 * montam consulta nem conhecem nome de tabela: assim, trocar uma regra de
 * acesso ou renomear uma coluna é mudança de um arquivo só.
 *
 * O banco é o do GRCON Flow. Nenhum endereço, chave ou tabela do GRCON
 * principal é usado ou aceito.
 */
(function (root) {
  "use strict";

  const config = root.FLOW_CONFIG || {};
  if (!config.supabaseUrl || !config.supabaseKey) {
    console.error("[GRCON Flow] flow_config.js não foi carregado. Rode `npm run build`.");
  }

  // O link de "esqueci minha senha" chega com `type=recovery` no fragmento, e o
  // supabase-js limpa a URL assim que troca o token por sessão. A leitura tem
  // que acontecer antes de `createClient` — depois dele, o rastro já pode ter
  // sumido e a tela mandaria a pessoa adiante ainda com a senha antiga.
  const CHEGOU_POR_RECUPERACAO = /(^|[#&?])type=recovery([&]|$)/.test(
    `${root.location.hash || ""}${root.location.search || ""}`
  );

  const client = root.supabase.createClient(config.supabaseUrl, config.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  const state = { session: null, profile: null, recuperacao: CHEGOU_POR_RECUPERACAO };
  const ouvintes = new Set();

  function texto(valor) {
    return valor === null || valor === undefined ? "" : String(valor).trim();
  }

  // O bucket continua privado; esta lista define o contrato do formulário.
  // A extensão é a fonte mais estável aqui porque alguns navegadores não
  // informam o MIME de arquivos do Office (ou informam application/octet-stream).
  // Os mesmos limites valem no banco e no bucket (migração flow_25).
  // Imagem entra na flow_32: o sistema guarda evidência de campo, e foto é a
  // forma mais comum dela. As extensões aqui espelham a restrição do banco —
  // oferecer na tela um formato que o banco recusa é prometer o que não cumpre.
  const EXTENSOES_IMAGEM = Object.freeze(["jpg", "jpeg", "png", "webp", "heic", "heif"]);
  const EXTENSOES_ANEXO = Object.freeze([
    "pdf", "xls", "xlsx", "xlsm", "doc", "docx", "dwg", ...EXTENSOES_IMAGEM,
  ]);
  const ACEITE_ANEXO = EXTENSOES_ANEXO.map((extensao) => `.${extensao}`).join(",");
  const TETO_ANEXOS = 30;
  const MAXIMO_ANEXOS = Math.min(TETO_ANEXOS, Math.max(1, Number(config.uploadMaxFiles) || TETO_ANEXOS));
  const MAXIMO_ANEXO_MB = Math.min(50, Math.max(1, Number(config.uploadMaxMb) || 50));
  const MAXIMO_TOTAL_ANEXOS_MB = Math.min(150, Math.max(1, Number(config.uploadMaxRequestMb) || 150));
  const FORMATOS_ANEXO = "PDF, Excel, Word, DWG ou imagem";
  const BLOCO_RESUMIVEL_BYTES = 6 * 1024 * 1024;
  // Lado maior da foto reduzida. 2200 px preserva leitura de placa, etiqueta e
  // trinca — que é o que uma evidência precisa mostrar.
  const LADO_MAXIMO_IMAGEM = 2200;
  const MIME_ANEXO = Object.freeze({
    pdf: "application/pdf",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xlsm: "application/vnd.ms-excel.sheet.macroenabled.12",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    dwg: "application/acad",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    heic: "image/heic",
    heif: "image/heif",
  });

  function ehImagem(arquivo) {
    return EXTENSOES_IMAGEM.includes(extensaoDoAnexo(arquivo));
  }

  function limiteDeBytes() {
    return MAXIMO_ANEXO_MB * 1024 * 1024;
  }

  function limiteTotalDeBytes() {
    return MAXIMO_TOTAL_ANEXOS_MB * 1024 * 1024;
  }

  function extensaoDoAnexo(arquivo) {
    return texto(arquivo && arquivo.name).toLowerCase().split(".").pop();
  }

  function validarAnexo(arquivo) {
    if (!arquivo || !texto(arquivo.name)) return "Escolha um arquivo válido.";
    const extensao = extensaoDoAnexo(arquivo);
    if (!EXTENSOES_ANEXO.includes(extensao)) {
      return `“${arquivo.name}” não é ${FORMATOS_ANEXO}.`;
    }
    if (!Number(arquivo.size)) return `“${arquivo.name}” está vazio.`;
    // Foto grande não é recusada aqui: `prepararAnexo` tenta reduzi-la antes de
    // desistir. Dizer "passou do tamanho" para um arquivo que o sistema
    // consegue enviar seria recusar o que ele aceita.
    if (!ehImagem(arquivo) && arquivo.size > limiteDeBytes()) {
      return `“${arquivo.name}” tem mais de ${MAXIMO_ANEXO_MB} MB.`;
    }
    return null;
  }

  /**
   * Reduz a foto no navegador, e só quando ela seria recusada por tamanho.
   *
   * Abaixo do limite o arquivo original sobe intacto — com EXIF, o que inclui
   * data, orientação e coordenada. Numa evidência de campo esses metadados
   * podem valer tanto quanto a imagem, e o `canvas` os descarta. Por isso a
   * redução é último recurso antes da recusa, nunca o caminho normal.
   *
   * Falha silenciosa é aceitável aqui: se o navegador não souber decodificar o
   * formato (HEIC no Chrome, por exemplo), devolvemos null e quem chamou
   * recusa com a mensagem de tamanho, que é a verdade.
   */
  async function reduzirImagem(arquivo) {
    if (typeof root.createImageBitmap !== "function" || typeof root.OffscreenCanvas === "undefined") {
      return null;
    }
    try {
      // `imageOrientation` aplica o giro do EXIF antes de desenhar; sem isso a
      // foto de celular chega deitada.
      const bitmap = await root.createImageBitmap(arquivo, { imageOrientation: "from-image" });
      const maior = Math.max(bitmap.width, bitmap.height);
      const escala = maior > LADO_MAXIMO_IMAGEM ? LADO_MAXIMO_IMAGEM / maior : 1;
      const largura = Math.round(bitmap.width * escala);
      const altura = Math.round(bitmap.height * escala);
      const tela = new root.OffscreenCanvas(largura, altura);
      const contexto = tela.getContext("2d");
      if (!contexto) { bitmap.close(); return null; }
      contexto.drawImage(bitmap, 0, 0, largura, altura);
      bitmap.close();
      const blob = await tela.convertToBlob({ type: "image/jpeg", quality: 0.85 });
      if (!blob || blob.size >= arquivo.size) return null;
      // O nome ganha a extensão do formato real: gravar um JPEG com nome .png
      // faria a restrição de MIME do banco recusar, e com razão.
      const nome = `${texto(arquivo.name).replace(/\.[^.]+$/, "")}.jpg`;
      return new File([blob], nome, { type: "image/jpeg", lastModified: Date.now() });
    } catch (erro) {
      console.error("[GRCON Flow · não foi possível reduzir a imagem]", erro);
      return null;
    }
  }

  /** Devolve o arquivo pronto para subir, ou o motivo de não subir. */
  async function prepararAnexo(arquivo) {
    const erro = validarAnexo(arquivo);
    if (erro) return { arquivo: null, error: erro };
    if (arquivo.size <= limiteDeBytes()) return { arquivo, error: null };

    const reduzido = ehImagem(arquivo) ? await reduzirImagem(arquivo) : null;
    if (reduzido && reduzido.size <= limiteDeBytes()) {
      return { arquivo: reduzido, error: null };
    }
    return {
      arquivo: null,
      error: `“${arquivo.name}” tem mais de ${MAXIMO_ANEXO_MB} MB.`,
    };
  }

  /**
   * Erro do Supabase vira mensagem que uma pessoa entende. A mensagem original
   * fica no console: a tela não deve despejar jargão de banco em quem só quis
   * enviar um pedido.
   */
  function traduzErro(erro, contexto) {
    if (!erro) return null;
    console.error(`[GRCON Flow] ${contexto || "erro"}:`, erro);
    const bruto = texto(erro.message || erro.error_description || erro);
    if (/Invalid login credentials/i.test(bruto)) return "E-mail ou senha incorretos.";
    if (/Email not confirmed/i.test(bruto)) return "Confirme seu e-mail antes de entrar.";
    if (/User already registered/i.test(bruto)) return "Este e-mail já tem cadastro. Faça login.";
    if (/Password should be at least/i.test(bruto)) return "A senha precisa ter pelo menos 6 caracteres.";
    if (/canceling statement due to statement timeout|statement timeout/i.test(bruto)) {
      return "O servidor levou mais tempo que o permitido. O protocolo, quando já exibido, continua salvo; tente novamente somente a etapa pendente.";
    }
    if (/flow_quick_templates_owner_name_uidx|duplicate key.*flow_quick_templates/i.test(bruto)) {
      return "Já existe um favorito com esse nome.";
    }
    if (/Você pode manter até 20 favoritos/i.test(bruto)) return "Você pode manter até 20 favoritos.";
    if (/LI\/MC.*N-1710|PDF e o Excel|PDF \+ Excel|PDF obrigatório|Excel obrigatório/i.test(bruto)) return bruto;
    if (/Limite de \d+ anexos complementares/i.test(bruto)) {
      return `Esta solicitação já tem o limite de ${MAXIMO_ANEXOS} anexos complementares.`;
    }
    if (/Limite de \d+ anexos/i.test(bruto)) {
      return `Esta solicitação já tem o limite de ${MAXIMO_ANEXOS} anexos.`;
    }
    if (/flow_attachments_(extension|mime)_valid|mime type|formato de anexo/i.test(bruto)) {
      return `Envie somente arquivos ${FORMATOS_ANEXO}.`;
    }
    if (/flow_attachments_size_valid|maximum allowed size|mais de \d+ MB/i.test(bruto)) {
      return `Cada anexo pode ter no máximo ${MAXIMO_ANEXO_MB} MB.`;
    }
    if (/limite total de 150 MB|ultrapassam o limite total/i.test(bruto)) {
      return `A soma dos anexos desta solicitação pode ter no máximo ${MAXIMO_TOTAL_ANEXOS_MB} MB.`;
    }
    if (/row-level security|permission denied|Sem permissão/i.test(bruto)) {
      return bruto.includes("Sem permissão") ? bruto : "Seu perfil não tem permissão para esta ação.";
    }
    if (/Failed to fetch|NetworkError/i.test(bruto)) return "Sem conexão com o servidor. Tente novamente.";
    if (/exceeded the maximum allowed size/i.test(bruto)) return "O arquivo passou do tamanho permitido.";
    return bruto || "Não foi possível concluir a operação.";
  }

  // Toda chamada devolve { data, error } com o erro já traduzido, para que a
  // tela não precise repetir tratamento em cada ponto.
  async function chamar(promessa, contexto) {
    try {
      const { data, error } = await promessa;
      if (error) return { data: null, error: traduzErro(error, contexto) };
      return { data, error: null };
    } catch (erro) {
      return { data: null, error: traduzErro(erro, contexto) };
    }
  }

  /** Como `chamar`, mas preserva a contagem que o PostgREST devolve no header. */
  async function chamarComTotal(promessa, contexto) {
    try {
      const { data, error, count } = await promessa;
      if (error) return { data: [], total: 0, error: traduzErro(error, contexto) };
      const linhas = data || [];
      // Sem `count` pedido, o total conhecido é o que veio.
      return { data: linhas, total: Number.isFinite(count) && count !== null ? count : linhas.length, error: null };
    } catch (erro) {
      return { data: [], total: 0, error: traduzErro(erro, contexto) };
    }
  }

  function avisar() {
    ouvintes.forEach((fn) => {
      try { fn(state.session, state.profile); } catch (erro) { console.error(erro); }
    });
  }

  async function carregarPerfil() {
    if (!state.session) { state.profile = null; return null; }
    const { data } = await chamar(
      client.from("flow_profiles").select("*").eq("id", state.session.user.id).maybeSingle(),
      "carregar perfil"
    );
    // O perfil nasce por gatilho no Auth. Se ainda não chegou (corrida na
    // primeira entrada), o app segue com o mínimo em vez de travar a tela.
    state.profile = data || {
      id: state.session.user.id,
      email: state.session.user.email || "",
      full_name: "",
      area: "",
      role: "solicitante",
      active: true,
    };
    return state.profile;
  }

  const auth = {
    get session() { return state.session; },
    get profile() { return state.profile; },
    get user() { return state.session ? state.session.user : null; },
    get role() { return state.profile ? state.profile.role : null; },

    /** Verdadeiro entre a chegada pelo link de recuperação e a troca da senha. */
    get recuperandoSenha() { return state.recuperacao; },
    concluiuRecuperacao() { state.recuperacao = false; },

    ehEquipe() { return ["operador", "administrador", "proprietario"].includes(auth.role); },
    ehAdmin() { return ["administrador", "proprietario"].includes(auth.role); },
    ehProprietario() { return auth.role === "proprietario"; },

    aoMudar(fn) { ouvintes.add(fn); return () => ouvintes.delete(fn); },

    async iniciar() {
      const { data } = await client.auth.getSession();
      state.session = data ? data.session : null;
      await carregarPerfil();
      client.auth.onAuthStateChange(async (evento, sessao) => {
        if (evento === "PASSWORD_RECOVERY") state.recuperacao = true;
        state.session = sessao;
        await carregarPerfil();
        avisar();
      });
      avisar();
      return state.profile;
    },

    async entrar(email, senha) {
      const { data, error } = await chamar(
        client.auth.signInWithPassword({ email: texto(email), password: senha }), "entrar"
      );
      if (error) return { error };
      state.session = data.session;
      await carregarPerfil();
      avisar();
      return { error: null };
    },

    async cadastrar(email, senha, nome, area) {
      const { error } = await chamar(
        client.auth.signUp({
          email: texto(email),
          password: senha,
          options: { data: { full_name: texto(nome), area: texto(area) } },
        }),
        "cadastrar"
      );
      return { error };
    },

    async recuperarSenha(email) {
      const { error } = await chamar(
        client.auth.resetPasswordForEmail(texto(email), { redirectTo: `${root.location.origin}/` }),
        "recuperar senha"
      );
      return { error };
    },

    async definirSenha(nova) {
      const { error } = await chamar(client.auth.updateUser({ password: nova }), "definir senha");
      if (!error) state.recuperacao = false;
      return { error };
    },

    async sair() {
      await client.auth.signOut();
      state.session = null;
      state.profile = null;
      state.recuperacao = false;
      avisar();
    },

    async atualizarPerfil(campos) {
      if (!state.session) return { error: "Sessão expirada." };
      const { error } = await chamar(
        client.rpc("flow_update_my_profile", {
          p_full_name: texto(campos.full_name),
          p_area: texto(campos.area),
          p_contact: texto(campos.contact),
        }),
        "atualizar perfil"
      );
      if (!error) await carregarPerfil();
      return { error };
    },
  };

  // ---------------------------------------------------------------------------
  // Tipos de solicitação e seus campos
  // ---------------------------------------------------------------------------
  const tipos = {
    async listar({ incluirInativos = false } = {}) {
      let consulta = client.from("flow_request_types")
        .select("*, campos:flow_type_fields(*)")
        .order("display_order", { ascending: true });
      if (!incluirInativos) consulta = consulta.eq("active", true);
      const { data, error } = await chamar(consulta, "listar tipos");
      if (error) return { data: [], error };
      const lista = (data || []).map((tipo) => ({
        ...tipo,
        campos: (tipo.campos || []).slice().sort((a, b) => a.display_order - b.display_order),
      }));
      return { data: lista, error: null };
    },

    async salvar(tipo) {
      const registro = {
        code: texto(tipo.code).toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
        label: texto(tipo.label),
        description: texto(tipo.description),
        active: tipo.active !== false,
        display_order: Number(tipo.display_order) || 0,
        uses_ld: Boolean(tipo.uses_ld),
        requires_document: Boolean(tipo.requires_document),
        allows_documents: Boolean(tipo.allows_documents),
        allows_multiple: Boolean(tipo.allows_multiple),
        title_search: Boolean(tipo.title_search),
        not_found_is_expected: Boolean(tipo.not_found_is_expected),
        answer_required: Boolean(tipo.answer_required),
        default_deadline_days: Number(tipo.default_deadline_days) || 5,
        default_priority: tipo.default_priority || "normal",
        updated_at: new Date().toISOString(),
      };
      if (!registro.code || !registro.label) return { error: "Informe código e rótulo do tipo." };
      const consulta = tipo.id
        ? client.from("flow_request_types").update(registro).eq("id", tipo.id)
        : client.from("flow_request_types").insert(registro);
      const { error } = await chamar(consulta, "salvar tipo");
      return { error };
    },

    async salvarCampo(campo) {
      const registro = {
        type_id: campo.type_id,
        field_key: texto(campo.field_key).toLowerCase().replace(/[^a-z0-9_]/g, "_"),
        label: texto(campo.label),
        help: texto(campo.help),
        placeholder: texto(campo.placeholder),
        field_kind: campo.field_kind || "text",
        options: Array.isArray(campo.options) ? campo.options : [],
        required: Boolean(campo.required),
        display_order: Number(campo.display_order) || 0,
      };
      if (!registro.field_key || !registro.label) return { error: "Informe a chave e o rótulo do campo." };
      const consulta = campo.id
        ? client.from("flow_type_fields").update(registro).eq("id", campo.id)
        : client.from("flow_type_fields").insert(registro);
      const { error } = await chamar(consulta, "salvar campo");
      return { error };
    },

    async removerCampo(id) {
      return chamar(client.from("flow_type_fields").delete().eq("id", id), "remover campo");
    },
  };

  // ---------------------------------------------------------------------------
  // Modelos pessoais do Registro rápido
  // ---------------------------------------------------------------------------
  const modelosRapidos = {
    limite: 20,

    async listar() {
      if (!auth.ehEquipe()) return { data: [], error: "Somente a equipe da Qualidade pode usar modelos rápidos." };
      const retorno = await chamar(
        client.from("flow_quick_templates")
          .select("id,name,type_code,requester_area,request_text,sort_order,created_at,updated_at")
          .order("sort_order", { ascending: true })
          .order("created_at", { ascending: true })
          .limit(20),
        "carregar modelos rápidos"
      );
      return { data: retorno.data || [], error: retorno.error };
    },

    async salvar(modelo) {
      if (!auth.ehEquipe()) return { data: null, error: "Somente a equipe da Qualidade pode salvar modelos rápidos." };
      const registro = {
        name: texto(modelo && modelo.name).slice(0, 60),
        type_code: texto(modelo && modelo.type_code),
        requester_area: texto(modelo && modelo.requester_area).slice(0, 120),
        request_text: texto(modelo && modelo.request_text).slice(0, 2000),
        sort_order: Math.max(0, Number(modelo && modelo.sort_order) || 0),
        updated_at: new Date().toISOString(),
      };
      if (!registro.name) return { data: null, error: "Dê um nome ao favorito." };
      if (!registro.type_code) return { data: null, error: "Escolha o tipo do favorito." };
      const consulta = modelo && modelo.id
        ? client.from("flow_quick_templates").update(registro).eq("id", modelo.id).select().single()
        : client.from("flow_quick_templates").insert(registro).select().single();
      return chamar(consulta, modelo && modelo.id ? "atualizar modelo rápido" : "salvar modelo rápido");
    },

    async excluir(id) {
      if (!auth.ehEquipe()) return { error: "Somente a equipe da Qualidade pode excluir modelos rápidos." };
      if (!texto(id)) return { error: "Modelo inválido." };
      const { error } = await chamar(
        client.from("flow_quick_templates").delete().eq("id", id),
        "excluir modelo rápido"
      );
      return { error };
    },

    async reordenar(modelos) {
      if (!auth.ehEquipe()) return { error: "Somente a equipe da Qualidade pode reorganizar modelos rápidos." };
      const lista = (modelos || []).filter((modelo) => texto(modelo && modelo.id));
      for (let indice = 0; indice < lista.length; indice += 1) {
        const { error } = await chamar(
          client.from("flow_quick_templates")
            .update({ sort_order: indice, updated_at: new Date().toISOString() })
            .eq("id", lista[indice].id),
          "reorganizar modelos rápidos"
        );
        if (error) return { error };
      }
      return { error: null };
    },
  };

  // ---------------------------------------------------------------------------
  // Solicitações
  // ---------------------------------------------------------------------------

  // Um recibo idempotente pode ser recuperado depois de a triagem já ter sido
  // concluída. Guardamos apenas esse caso para não repetir a etapa imediatamente.
  // Na criação normal `triage_completed` é falso: registrar o protocolo e triar
  // as LDs são transações separadas desde a flow_35.
  const triadasNoServidor = new Set();

  // Teto da exportação. Alto porque são só protocolos, e ainda assim finito:
  // uma consulta sem limite é um pedido de tempo limite no PostgREST.
  const TETO_DE_EXPORTACAO = 20000;

  // Lista fechada: o nome da coluna vai para dentro da consulta, e o que a tela
  // pede nunca deve poder virar SQL que ninguém previu. Progresso não está aqui
  // de propósito — "2 de 2" e "2 de 10" não se comparam por `items_done`, e
  // ordenar por ele venderia uma ordem que não é a que a coluna mostra.
  const ORDENS_DE_SOLICITACAO = Object.freeze({
    protocol: "protocol",
    type_label: "type_label",
    requester_name: "requester_name",
    created_at: "created_at",
    owner_name: "owner_name",
    priority: "priority",
    origin: "origin",
    status: "status",
    due_at: "due_at",
  });

  /**
   * Ordena de forma determinística. O desempate por protocolo não é enfeite: sem
   * uma ordem total, duas solicitações com o mesmo instante de criação podem
   * aparecer em duas páginas ou em nenhuma, porque cada consulta é uma leitura
   * nova e o banco não deve ordem estável a quem não pediu.
   */
  function aplicarOrdem(consulta, ordem) {
    const coluna = ORDENS_DE_SOLICITACAO[texto(ordem && ordem.coluna)] || "created_at";
    const ascendente = Boolean(ordem && ordem.ascendente);
    let ordenada = consulta.order(coluna, { ascending: ascendente, nullsFirst: false });
    if (coluna !== "protocol") ordenada = ordenada.order("protocol", { ascending: false });
    return ordenada;
  }

  /**
   * Um lugar só para os filtros do painel. `listar` e `protocolos` precisam
   * concordar sempre: se a exportação usasse outra regra, o arquivo sairia com
   * um conjunto diferente do que a pessoa está vendo.
   */
  function aplicarFiltrosDeSolicitacao(consultaInicial, filtros = {}) {
    let consulta = consultaInicial;
    if (filtros.status) consulta = consulta.eq("status", filtros.status);
    if (filtros.tipo) consulta = consulta.eq("type_code", filtros.tipo);
    if (filtros.responsavel) consulta = consulta.eq("owner_name", filtros.responsavel);
    if (filtros.meus && state.session) consulta = consulta.eq("requester_id", state.session.user.id);
    if (filtros.de) consulta = consulta.gte("created_at", filtros.de);
    if (filtros.ate) consulta = consulta.lte("created_at", `${filtros.ate}T23:59:59`);
    if (filtros.abertas) consulta = consulta.not("status", "in", "(concluido,cancelado)");
    if (filtros.atrasadas) {
      const hoje = new Date().toISOString().slice(0, 10);
      consulta = consulta.not("status", "in", "(concluido,cancelado)").lt("due_at", hoje);
    }
    // A mesma expressão do contador do indicador, de propósito: o número do
    // cartão e a lista que ele abre têm que falar do mesmo conjunto.
    if (filtros.semResponsavel) {
      consulta = consulta.not("status", "in", "(concluido,cancelado)").eq("owner_name", "");
    }
    if (filtros.classificacao) consulta = consulta.eq("filtro_itens.classification", filtros.classificacao);
    // A origem é coluna da própria solicitação desde a flow_30, agregada dos
    // itens pelo banco. Por isso não precisa do `!inner` da classificação: é
    // igualdade simples, ordena, e o total do rodapé não depende de embed.
    if (filtros.origem) consulta = consulta.eq("origin", filtros.origem);
    // "urgentes" é o recorte que a equipe abre pelo cartão do indicador: só o
    // que está em aberto, porque urgência de pedido concluído não é fila.
    if (filtros.urgentes) {
      consulta = consulta.not("status", "in", "(concluido,cancelado)").in("priority", ["alta", "urgente"]);
    } else if (filtros.prioridade) {
      consulta = consulta.eq("priority", filtros.prioridade);
    }
    if (filtros.busca) {
      const termo = texto(filtros.busca).replace(/[%,()]/g, " ");
      consulta = consulta.or(
        `protocol.ilike.%${termo}%,requester_name.ilike.%${termo}%,summary.ilike.%${termo}%,type_label.ilike.%${termo}%`
      );
    }
    return consulta;
  }

  const solicitacoes = {
    /**
     * Registra a solicitação. O protocolo é gerado pelo banco, numa operação
     * atômica: dois envios simultâneos nunca recebem o mesmo número.
     */
    async criar(dados) {
      const retorno = await chamar(
        client.rpc("flow_create_request", {
          p_type_code: dados.tipo,
          p_requester_name: texto(dados.nome),
          p_requester_area: texto(dados.area),
          p_requester_contact: texto(dados.contato),
          p_summary: texto(dados.resumo),
          p_description: texto(dados.descricao),
          p_form_data: dados.formulario || {},
          p_items: dados.itens || [],
        }),
        "registrar solicitação"
      );
      if (retorno.data && retorno.data.triage_completed && retorno.data.id) {
        triadasNoServidor.add(retorno.data.id);
      }
      return retorno;
    },

    /**
     * Entrada compacta do painel. A RPC repete a autorização no Postgres:
     * esconder o botão é conforto de interface, não a barreira de segurança.
     */
    async criarRapida(dados) {
      if (!auth.ehEquipe()) {
        return { data: null, error: "Somente a equipe da Qualidade pode usar o registro rápido." };
      }
      const retorno = await chamar(
        client.rpc("flow_create_staff_request", {
          p_type_code: dados.tipo,
          p_requester_name: texto(dados.nome),
          p_requester_area: texto(dados.area),
          p_requester_contact: texto(dados.contato),
          p_summary: texto(dados.resumo),
          p_description: texto(dados.descricao),
          p_form_data: dados.formulario || {},
          p_items: dados.itens || [],
        }),
        "registrar solicitação pela Qualidade"
      );
      if (retorno.data && retorno.data.triage_completed && retorno.data.id) {
        triadasNoServidor.add(retorno.data.id);
      }
      return retorno;
    },

    /**
     * Devolve a página pedida e o total do recorte. Todo filtro é aplicado no
     * servidor — inclusive os três que antes eram recortes do navegador. Peneirar
     * depois de trazer as linhas só funcionava porque a tela trazia tudo: numa
     * página de 50, "atrasadas" mostraria as atrasadas das 50 primeiras, não as
     * atrasadas da base, e o total no rodapé seria uma invenção.
     */
    async listar(filtros = {}) {
      // O item guarda a classificação; a solicitação, não. O `!inner` traz só as
      // solicitações que têm ao menos um item naquela classificação, sem repetir
      // a linha e sem carregar os itens para a tela.
      const colunas = filtros.classificacao
        ? "*, filtro_itens:flow_request_items!inner(id)"
        : "*";
      let consulta = aplicarOrdem(
        client.from("flow_requests").select(colunas, { count: "exact" }),
        filtros.ordem
      );
      consulta = aplicarFiltrosDeSolicitacao(consulta, filtros);
      const inicio = Math.max(0, Number(filtros.inicio) || 0);
      const tamanho = Math.max(1, Number(filtros.limite) || 100);
      consulta = consulta.range(inicio, inicio + tamanho - 1);
      return chamarComTotal(consulta, "listar solicitações");
    },

    /**
     * Só os protocolos do recorte inteiro, para a exportação não ficar presa à
     * página que está na tela. Uma coluna e um teto alto: é uma lista de
     * strings curtas, não as linhas.
     */
    async protocolos(filtros = {}) {
      let consulta = aplicarOrdem(client.from("flow_requests").select("protocol"), filtros.ordem);
      consulta = aplicarFiltrosDeSolicitacao(consulta, filtros);
      const { data, error } = await chamar(consulta.limit(TETO_DE_EXPORTACAO), "listar protocolos");
      if (error) return { data: [], error };
      return { data: (data || []).map((linha) => linha.protocol).filter(Boolean), error: null };
    },

    async obter(id) {
      return chamar(
        client.from("flow_requests")
          .select("*, itens:flow_request_items(*), anexos:flow_attachments(*)")
          .eq("id", id)
          .maybeSingle(),
        "abrir solicitação"
      );
    },

    async porProtocolo(protocolo) {
      return chamar(
        client.rpc("flow_track_protocol", { p_protocol: texto(protocolo).toUpperCase() }),
        "consultar protocolo"
      );
    },

    async atualizar(id, campo, valor, nota) {
      return chamar(
        client.rpc("flow_update_request", {
          p_request_id: id, p_field: campo, p_value: texto(valor), p_note: texto(nota),
        }),
        "atualizar solicitação"
      );
    },

    /**
     * Prioridade tem caminho próprio porque tem dono próprio. `flow_update_request`
     * é da equipe: ela abre status, responsável, prazo e resposta de uma vez, e
     * nada disso é do solicitante. Já a urgência do próprio pedido é dele — o RPC
     * abaixo aceita a equipe em qualquer solicitação e o solicitante apenas na
     * que ele mesmo registrou, enquanto ela ainda estiver aberta.
     * O painel continua usando `atualizar`.
     */
    async definirPrioridade(id, prioridade, nota) {
      return chamar(
        client.rpc("flow_set_request_priority", {
          p_request_id: id, p_priority: texto(prioridade), p_note: texto(nota),
        }),
        "definir prioridade"
      );
    },

    /**
     * Exclusão administrativa e permanente. Os objetos privados saem pelo
     * Storage API antes da linha principal, evitando arquivos órfãos no bucket.
     * O RPC repete a autorização no banco; esconder o botão não é a proteção.
     */
    async excluir(id, anexos = []) {
      if (!auth.ehAdmin()) return { data: null, error: "Seu perfil não tem permissão para excluir solicitações." };
      const pasta = texto(id);
      const listagem = await chamar(
        client.storage.from("flow-anexos").list(pasta, { limit: 100 }),
        "conferir anexos da solicitação"
      );
      if (listagem.error) return listagem;
      const encontrados = (listagem.data || [])
        .filter((objeto) => objeto && objeto.id && texto(objeto.name))
        .map((objeto) => `${pasta}/${objeto.name}`);
      const caminhos = [...new Set([
        ...(anexos || []).map((anexo) => texto(anexo.storage_path)).filter(Boolean),
        ...encontrados,
      ])];
      if (caminhos.length) {
        const remocao = await chamar(
          client.storage.from("flow-anexos").remove(caminhos),
          "remover anexos da solicitação"
        );
        if (remocao.error) return remocao;
      }

      const exclusao = await chamar(
        client.rpc("flow_delete_request", { p_request_id: id }),
        "excluir solicitação"
      );
      if (exclusao.error) {
        const prefixo = caminhos.length ? "Os anexos foram removidos, mas " : "";
        return { data: null, error: `${prefixo}${exclusao.error}` };
      }
      const resultado = Array.isArray(exclusao.data) ? exclusao.data[0] : exclusao.data;
      if (!resultado || !resultado.deleted) {
        return { data: null, error: "Solicitação não encontrada ou já excluída." };
      }
      return { data: resultado, error: null };
    },

    /** Indicadores do painel. Contagem no servidor, sem trazer as linhas. */
    async indicadores() {
      const hoje = new Date().toISOString().slice(0, 10);
      const contar = async (montar) => {
        const { count } = await montar(
          client.from("flow_requests").select("id", { count: "exact", head: true })
        );
        return count || 0;
      };
      const contarItens = async (montar) => {
        const { count } = await montar(
          client.from("flow_request_items").select("id", { count: "exact", head: true })
        );
        return count || 0;
      };
      const abertas = (q) => q.not("status", "in", "(concluido,cancelado)");
      const urgentes = (q) => abertas(q).in("priority", ["alta", "urgente"]);
      const [
        emAberto, hojeRecebidas, execucao, validacao, atrasadas, concluidas, semResponsavel,
        naoLocalizados, pendenteId, semAlocacao, urgentesAbertas,
      ] = await Promise.all([
        contar(abertas),
        contar((q) => q.gte("created_at", `${hoje}T00:00:00`)),
        contar((q) => q.eq("status", "em_execucao")),
        contar((q) => q.eq("status", "aguardando_validacao")),
        contar((q) => abertas(q).lt("due_at", hoje)),
        contar((q) => q.eq("status", "concluido")),
        contar((q) => abertas(q).eq("owner_name", "")),
        contarItens((q) => q.eq("classification", "NAO_LOCALIZADO")),
        contarItens((q) => q.eq("classification", "IDENTIFICACAO_PENDENTE")),
        contarItens((q) => q.eq("classification", "ACAO_NECESSARIA")),
        contar(urgentes),
      ]);
      return {
        emAberto, hojeRecebidas, execucao, validacao, atrasadas, concluidas,
        semResponsavel, naoLocalizados, pendenteId, semAlocacao, urgentesAbertas,
      };
    },
  };

  // ---------------------------------------------------------------------------
  // Itens e triagem
  // ---------------------------------------------------------------------------
  const itens = {
    async listar(filtros = {}) {
      let consulta = client.from("flow_request_items")
        .select("*, solicitacao:flow_requests!inner(protocol,type_code,type_label,requester_name,requester_area,status,priority,due_at,created_at,owner_name)")
        .order("created_at", { ascending: false });
      if (filtros.classificacao) consulta = consulta.eq("classification", filtros.classificacao);
      if (filtros.status) consulta = consulta.eq("status", filtros.status);
      if (filtros.tipo) consulta = consulta.eq("solicitacao.type_code", filtros.tipo);
      if (filtros.validar) consulta = consulta.eq("needs_validation", true);
      consulta = consulta.range(filtros.inicio || 0, (filtros.inicio || 0) + (filtros.limite || 200) - 1);
      return chamar(consulta, "listar itens");
    },

    async atualizar(ids, campo, valor, nota) {
      return chamar(
        client.rpc("flow_update_items", {
          p_item_ids: ids, p_field: campo, p_value: texto(valor), p_note: texto(nota),
        }),
        "atualizar itens"
      );
    },

    async historicoTriagem(itemId) {
      return chamar(
        client.from("flow_triage_runs").select("*").eq("item_id", itemId)
          .order("run_number", { ascending: false }),
        "histórico de triagem"
      );
    },
  };

  const triagem = {
    /**
     * Tria a solicitação item a item.
     *
     * Cada item é uma transação independente. Uma lista grande pode levar mais
     * tempo, mas nunca volta a colocar o protocolo inteiro sob o timeout de uma
     * única chamada. `aoProgresso` é opcional e mantém a tela responsiva.
     */
    async solicitacao(id, aoProgresso) {
      if (triadasNoServidor.has(id)) {
        triadasNoServidor.delete(id);
        return { data: { already_triaged: true }, error: null };
      }

      const lista = await chamar(
        client.from("flow_request_items").select("id,item_number")
          .eq("request_id", id).order("item_number", { ascending: true }),
        "preparar triagem"
      );
      if (lista.error) return lista;

      const itens = lista.data || [];
      const resumo = {};
      for (let indice = 0; indice < itens.length; indice += 1) {
        const retorno = await chamar(
          client.rpc("flow_triage_item", { target_item: itens[indice].id }),
          `triar item ${indice + 1} de ${itens.length}`
        );
        if (retorno.error) {
          return {
            data: { items: indice, total: itens.length, summary: resumo, partial: true },
            error: retorno.error,
          };
        }
        const classificacao = texto(retorno.data && retorno.data.classification) || "SEM_CLASSIFICACAO";
        resumo[classificacao] = (resumo[classificacao] || 0) + 1;
        if (typeof aoProgresso === "function") {
          try { aoProgresso({ atual: indice + 1, total: itens.length, classificacao }); }
          catch (erro) { console.error("[GRCON Flow · progresso da triagem]", erro); }
        }
      }

      return chamar(
        client.rpc("flow_complete_request_triage", { target_request: id }),
        "concluir triagem"
      );
    },
    async item(id) {
      return chamar(client.rpc("flow_triage_item", { target_item: id }), "triar item");
    },
    async buscarPorTitulo(titulo, limite) {
      return chamar(
        client.rpc("flow_search_by_title", { p_query: texto(titulo), p_limit: limite || 12 }),
        "buscar por título"
      );
    },
    async consultarDocumento(chaves) {
      return chamar(client.rpc("flow_lookup_document", { p_keys: chaves }), "consultar documento");
    },
  };

  // ---------------------------------------------------------------------------
  // Base Documental (LDs)
  // ---------------------------------------------------------------------------
  const lds = {
    async listar() {
      return chamar(
        client.from("flow_lds")
          // Há duas relações entre LD e versão: a coleção histórica (ld_id) e
          // a versão vigente (current_version_id). Informar a FK evita o HTTP
          // 300 "Multiple Choices" do PostgREST quando a aba é aberta.
          .select("*, versoes:flow_ld_versions!flow_ld_versions_ld_id_fkey(id,revision_label,file_name,document_count,status,created_at,activated_at,uploaded_by_name,error_message,source_hash,import_report,sheets)")
          .order("display_order", { ascending: true }),
        "listar LDs"
      );
    },

    async salvar(ld) {
      const registro = {
        code: texto(ld.code).toUpperCase().replace(/\s+/g, "_"),
        name: texto(ld.name),
        description: texto(ld.description),
        active: ld.active !== false,
        display_order: Number(ld.display_order) || 0,
        updated_at: new Date().toISOString(),
      };
      if (!registro.code) return { error: "Informe o identificador da LD (ex.: LD_004)." };
      return chamar(client.rpc("flow_save_ld", {
        p_id: ld.id || null,
        p_code: registro.code,
        p_name: registro.name,
        p_description: registro.description,
        p_active: registro.active,
        p_display_order: registro.display_order,
      }), "salvar LD");
    },

    async criarVersao(ldId, arquivo, revisao, analise) {
      const perfil = state.profile || {};
      return chamar(
        client.rpc("flow_create_ld_version", {
          p_ld_id: ldId,
          p_revision_label: texto(revisao),
          p_file_name: texto(arquivo && arquivo.name),
          p_uploaded_by_name: texto(perfil.full_name || perfil.email),
          p_source_hash: texto(analise && analise.hash),
          p_sheets: (analise && analise.relatorio && analise.relatorio.included_sheets) || [],
          p_import_report: (analise && analise.relatorio) || {},
        }),
        "criar versão da LD"
      );
    },

    /** Um lote por chamada: a planilha inteira numa requisição só estouraria. */
    async enviarLote(versaoId, documentos) {
      return chamar(
        client.rpc("flow_ingest_ld_documents", { target_version: versaoId, docs: documentos }),
        "indexar documentos"
      );
    },

    async ativarVersao(versaoId) {
      return chamar(client.rpc("flow_activate_ld_version", { target_version: versaoId }), "ativar versão");
    },

    async finalizarVersao(versaoId, relatorio) {
      return chamar(
        client.rpc("flow_finalize_ld_version", { target_version: versaoId, p_report: relatorio || {} }),
        "finalizar versão"
      );
    },

    async marcarErro(versaoId, mensagem) {
      return chamar(
        client.rpc("flow_fail_ld_version", {
          target_version: versaoId, p_message: texto(mensagem).slice(0, 500),
        }),
        "registrar falha da versão"
      );
    },

    async removerVersao(versaoId) {
      return chamar(client.rpc("flow_delete_ld_version", { target_version: versaoId }), "remover versão");
    },

    async guardarArquivo(versaoId, arquivo) {
      const caminho = `${versaoId}/${arquivo.name}`;
      const { error } = await chamar(
        client.storage.from("flow-lds").upload(caminho, arquivo, { upsert: true }),
        "guardar arquivo da LD"
      );
      if (error) return { error };
      const salvo = await chamar(
        client.rpc("flow_set_ld_storage_path", { target_version: versaoId, p_storage_path: caminho }),
        "vincular arquivo da LD"
      );
      return { error: salvo.error };
    },
  };

  // ---------------------------------------------------------------------------
  // Normas e catálogos de codificação
  // ---------------------------------------------------------------------------
  const normas = {
    async listar() {
      return chamar(client.rpc("flow_list_norms"), "listar normas");
    },

    async regrasAtivas() {
      return chamar(client.rpc("flow_active_code_rules"), "carregar regras vigentes");
    },

    async criarVersao(dados, arquivo) {
      if (!arquivo || !/\.pdf$/i.test(texto(arquivo.name))) {
        return { data: null, error: "Anexe um arquivo PDF da norma." };
      }
      const criado = await chamar(client.rpc("flow_create_norm_version", {
        p_norm_code: texto(dados.norm_code).toUpperCase(),
        p_norm_title: texto(dados.norm_title),
        p_revision: texto(dados.revision),
        p_effective_date: dados.effective_date || null,
        p_file_name: texto(arquivo && arquivo.name),
        p_notes: texto(dados.notes),
        p_rules: dados.rules || {},
      }), "registrar revisão da norma");
      if (criado.error || !arquivo) return criado;
      const versao = criado.data;
      const nomeSeguro = arquivo.name.replace(/[^\w.\- ]+/g, "_");
      const caminho = `${versao.id}/${nomeSeguro}`;
      const guardado = await chamar(
        client.storage.from("flow-normas").upload(caminho, arquivo, { upsert: false }),
        "guardar arquivo da norma"
      );
      if (guardado.error) {
        await chamar(client.rpc("flow_fail_norm_version", {
          target_version: versao.id, p_message: guardado.error,
        }), "registrar falha da norma");
        return { data: null, error: guardado.error };
      }
      const vinculo = await chamar(client.rpc("flow_set_norm_storage_path", {
        target_version: versao.id, p_storage_path: caminho,
      }), "vincular arquivo da norma");
      return vinculo.error ? { data: null, error: vinculo.error } : criado;
    },

    async urlArquivo(caminho) {
      const seguro = texto(caminho);
      if (!seguro) return { data: null, error: "Esta revisão ainda não possui PDF controlado." };
      const resultado = await chamar(
        client.storage.from("flow-normas").createSignedUrl(seguro, 600),
        "abrir PDF da norma"
      );
      return resultado.error
        ? { data: null, error: resultado.error }
        : { data: resultado.data && resultado.data.signedUrl, error: null };
    },

    async ativarVersao(id) {
      return chamar(client.rpc("flow_activate_norm_version", { target_version: id }), "ativar norma");
    },

    async prepararExclusao(id) {
      if (!auth.ehProprietario()) {
        return { data: null, error: "Somente o proprietário pode excluir uma norma." };
      }
      return chamar(
        client.rpc("flow_prepare_norm_deletion", { target_norm: id }),
        "preparar exclusão da norma"
      );
    },

    async excluir(id, codigoConfirmado, preparoExistente = null) {
      if (!auth.ehProprietario()) {
        return { data: null, error: "Somente o proprietário pode excluir uma norma." };
      }
      const preparo = preparoExistente
        ? { data: preparoExistente, error: null }
        : await normas.prepararExclusao(id);
      if (preparo.error) return preparo;

      const caminhos = Array.isArray(preparo.data && preparo.data.storage_paths)
        ? preparo.data.storage_paths.filter(Boolean) : [];
      if (texto(codigoConfirmado).toUpperCase() !== texto(preparo.data && preparo.data.code).toUpperCase()) {
        return { data: null, error: "Digite o código exato da norma para confirmar a exclusão." };
      }
      if (caminhos.length) {
        const removido = await chamar(
          client.storage.from("flow-normas").remove(caminhos),
          "remover PDFs da norma"
        );
        if (removido.error) return { data: null, error: removido.error };
      }

      const apagado = await chamar(client.rpc("flow_delete_norm", {
        target_norm: id,
        p_confirm_code: texto(codigoConfirmado),
      }), "excluir norma");
      if (!apagado.error) armazenamento.sinalizarMudanca();
      return apagado;
    },

    async salvarCodigo(catalogo, codigo, rotulo, ativo = true) {
      return chamar(client.rpc("flow_save_catalog_entry", {
        p_catalog_code: texto(catalogo).toUpperCase(),
        p_entry_code: texto(codigo).toUpperCase(),
        p_label: texto(rotulo),
        p_active: Boolean(ativo),
      }), "salvar código da qualidade");
    },

    async listarCodigos(catalogo) {
      return chamar(client.rpc("flow_list_catalog_entries", {
        p_catalog_code: texto(catalogo).toUpperCase(),
      }), "listar códigos da qualidade");
    },
  };

  // ---------------------------------------------------------------------------
  // Comentários, anexos, histórico, notificações e usuários
  // ---------------------------------------------------------------------------
  const comentarios = {
    async listar(requestId) {
      return chamar(
        client.from("flow_comments").select("*").eq("request_id", requestId)
          .order("created_at", { ascending: true }),
        "listar comentários"
      );
    },
    async criar(requestId, corpo, interno = true, itemId = null) {
      const perfil = state.profile || {};
      return chamar(
        client.from("flow_comments").insert({
          request_id: requestId,
          item_id: itemId,
          body: texto(corpo),
          internal: interno,
          author_id: state.session ? state.session.user.id : null,
          author_name: texto(perfil.full_name || perfil.email),
        }),
        "comentar"
      );
    },
  };

  function base64Metadata(valor) {
    const bytes = new root.TextEncoder().encode(texto(valor));
    let binario = "";
    bytes.forEach((byte) => { binario += String.fromCharCode(byte); });
    return root.btoa(binario);
  }

  function aguardarUpload(ms) {
    return new Promise((resolver) => root.setTimeout(resolver, ms));
  }

  async function enviarAnexoResumivel(caminho, arquivo, mimeType, aoProgresso) {
    const sessao = await client.auth.getSession();
    const token = sessao.data && sessao.data.session && sessao.data.session.access_token;
    if (!token) throw new Error("Sua sessão expirou. Entre novamente antes de enviar o arquivo.");

    const projeto = new URL(config.supabaseUrl).hostname.split(".")[0];
    const endpoint = `https://${projeto}.storage.supabase.co/storage/v1/upload/resumable`;
    const comuns = {
      Authorization: `Bearer ${token}`,
      apikey: config.supabaseKey,
      "Tus-Resumable": "1.0.0",
    };
    const criado = await root.fetch(endpoint, {
      method: "POST",
      headers: {
        ...comuns,
        "Upload-Length": String(arquivo.size),
        "Upload-Metadata": [
          `bucketName ${base64Metadata("flow-anexos")}`,
          `objectName ${base64Metadata(caminho)}`,
          `contentType ${base64Metadata(mimeType)}`,
          `cacheControl ${base64Metadata("3600")}`,
        ].join(","),
        "x-upsert": "false",
      },
    });
    if (!criado.ok) throw new Error((await criado.text()) || `Falha ao iniciar o envio (${criado.status}).`);
    const local = criado.headers.get("Location");
    if (!local) throw new Error("O servidor não devolveu o endereço do envio retomável.");
    const uploadUrl = new URL(local, endpoint).toString();

    let enviados = 0;
    const esperas = [0, 1000, 3000, 5000, 10000];
    while (enviados < arquivo.size) {
      const fim = Math.min(arquivo.size, enviados + BLOCO_RESUMIVEL_BYTES);
      let concluido = false;
      let ultimoErro = null;
      for (const espera of esperas) {
        if (espera) await aguardarUpload(espera);
        try {
          const resposta = await root.fetch(uploadUrl, {
            method: "PATCH",
            headers: {
              ...comuns,
              "Content-Type": "application/offset+octet-stream",
              "Upload-Offset": String(enviados),
            },
            body: arquivo.slice(enviados, fim),
          });
          if (!resposta.ok) throw new Error((await resposta.text()) || `Falha no envio (${resposta.status}).`);
          enviados = Number(resposta.headers.get("Upload-Offset")) || fim;
          concluido = true;
          if (typeof aoProgresso === "function") {
            aoProgresso({ enviados, total: arquivo.size, percentual: Math.round((enviados / arquivo.size) * 100) });
          }
          break;
        } catch (erro) {
          ultimoErro = erro;
          // Confere quanto o servidor recebeu antes de repetir o bloco. Isso
          // evita duplicar bytes quando a resposta se perdeu após um PATCH aceito.
          try {
            const cabeca = await root.fetch(uploadUrl, { method: "HEAD", headers: comuns });
            if (cabeca.ok) enviados = Number(cabeca.headers.get("Upload-Offset")) || enviados;
            if (enviados >= fim) { concluido = true; break; }
          } catch (_) { /* a próxima tentativa mantém o último offset conhecido */ }
        }
      }
      if (!concluido) throw ultimoErro || new Error("Não foi possível concluir o envio retomável.");
    }
  }

  async function guardarObjetoAnexo(caminho, arquivo, mimeType, aoProgresso) {
    if (arquivo.size > BLOCO_RESUMIVEL_BYTES) {
      try {
        await enviarAnexoResumivel(caminho, arquivo, mimeType, aoProgresso);
        return { data: { path: caminho }, error: null };
      } catch (erro) {
        return { data: null, error: traduzErro(erro, "enviar anexo retomável") };
      }
    }
    if (typeof aoProgresso === "function") aoProgresso({ enviados: 0, total: arquivo.size, percentual: 0 });
    const retorno = await chamar(
      client.storage.from("flow-anexos").upload(caminho, arquivo, {
        contentType: mimeType,
        upsert: false,
      }),
      "enviar anexo"
    );
    if (!retorno.error && typeof aoProgresso === "function") {
      aoProgresso({ enviados: arquivo.size, total: arquivo.size, percentual: 100 });
    }
    return retorno;
  }

  const anexos = {
    extensoes: EXTENSOES_ANEXO,
    accept: ACEITE_ANEXO,
    maximo: MAXIMO_ANEXOS,
    maximoMb: MAXIMO_ANEXO_MB,
    maximoTotalMb: MAXIMO_TOTAL_ANEXOS_MB,
    limiteTotalBytes: limiteTotalDeBytes(),
    formatos: FORMATOS_ANEXO,
    extensoes: EXTENSOES_ANEXO,
    imagens: EXTENSOES_IMAGEM,
    validar: validarAnexo,
    preparar: prepararAnexo,

    async enviar(requestId, arquivoOriginal, itemId = null, aoProgresso = null) {
      const preparado = await prepararAnexo(arquivoOriginal);
      if (preparado.error) return { data: null, error: preparado.error };
      const arquivo = preparado.arquivo;
      const nomeSeguro = arquivo.name.replace(/[^\w.\- ]+/g, "_");
      const identificador = root.crypto && typeof root.crypto.randomUUID === "function"
        ? root.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const caminho = `${requestId}/${identificador}-${nomeSeguro}`;
      const mimeType = MIME_ANEXO[extensaoDoAnexo(arquivo)];
      const { error } = await guardarObjetoAnexo(caminho, arquivo, mimeType, aoProgresso);
      if (error) {
        // Um envio retomável interrompido pode já ter criado o objeto. Remover
        // pelo caminho é idempotente e impede que uma tentativa falha consuma cota.
        await client.storage.from("flow-anexos").remove([caminho]);
        return { error };
      }
      const registro = await chamar(
        client.rpc("flow_register_attachment", {
          p_request_id: requestId,
          p_item_id: itemId,
          p_file_name: arquivo.name,
          p_storage_path: caminho,
          p_mime_type: mimeType,
          p_size_bytes: arquivo.size,
        }),
        "registrar anexo"
      );
      // Não deixa arquivo órfão no bucket se a gravação dos metadados falhar.
      if (registro.error) await client.storage.from("flow-anexos").remove([caminho]);
      return registro;
    },

    async link(caminho) {
      const { data } = await client.storage.from("flow-anexos").createSignedUrl(caminho, 300);
      return data ? data.signedUrl : null;
    },

    /** URL curta e privada, com Content-Disposition de download e nome original. */
    async linkDownload(caminho, nomeArquivo) {
      const { data, error } = await chamar(
        client.storage.from("flow-anexos").createSignedUrl(caminho, 300, {
          download: texto(nomeArquivo) || true,
        }),
        "preparar download do anexo"
      );
      return { data: data ? data.signedUrl : null, error };
    },
  };

  const armazenamento = {
    async resumo() {
      // Métricas de capacidade são informação administrativa sensível e só
      // pertencem ao proprietário. A RPC repete a mesma regra no servidor.
      if (!auth.ehProprietario()) return { data: null, error: "Somente o proprietário pode consultar o armazenamento." };
      return chamar(client.rpc("flow_storage_usage"), "consultar armazenamento");
    },
    observar(fn) {
      if (!state.session || !auth.ehProprietario() || typeof fn !== "function") return () => {};
      const sufixo = state.session.user.id || Math.random().toString(36).slice(2);
      const aoMudarLocalmente = () => fn({ eventType: "LOCAL_STORAGE_CHANGE" });
      root.addEventListener("flow:storage-updated", aoMudarLocalmente);
      const canal = client.channel(`flow-armazenamento-${sufixo}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "flow_attachments" }, fn)
        .on("postgres_changes", { event: "*", schema: "public", table: "flow_ld_versions" }, fn)
        .on("postgres_changes", { event: "*", schema: "public", table: "flow_norm_versions" }, fn)
        .subscribe();
      return () => {
        root.removeEventListener("flow:storage-updated", aoMudarLocalmente);
        client.removeChannel(canal);
      };
    },
    sinalizarMudanca() {
      root.dispatchEvent(new root.CustomEvent("flow:storage-updated"));
    },
  };

  const historico = {
    async listar(requestId) {
      return chamar(
        client.from("flow_history").select("*").eq("request_id", requestId)
          .order("created_at", { ascending: false }),
        "listar histórico"
      );
    },
  };

  const notificacoes = {
    async listar() {
      if (!state.session) return { data: [], error: null };
      return chamar(
        client.from("flow_notifications").select("*")
          .eq("user_id", state.session.user.id)
          .order("created_at", { ascending: false }).limit(50),
        "listar notificações"
      );
    },
    async contarNaoLidas() {
      if (!state.session) return { data: 0, error: null };
      try {
        const { count, error } = await client.from("flow_notifications")
          .select("id", { count: "exact", head: true })
          .eq("user_id", state.session.user.id).is("read_at", null);
        if (error) return { data: 0, error: traduzErro(error, "contar notificações") };
        return { data: Number(count) || 0, error: null };
      } catch (erro) {
        return { data: 0, error: traduzErro(erro, "contar notificações") };
      }
    },
    async marcarLida(id) {
      if (!state.session) return { data: null, error: "Entre novamente para continuar." };
      return chamar(
        client.from("flow_notifications").update({ read_at: new Date().toISOString() })
          .eq("id", id).eq("user_id", state.session.user.id),
        "marcar notificação"
      );
    },
    async marcarTodasLidas() {
      if (!state.session) return { data: null, error: "Entre novamente para continuar." };
      return chamar(
        client.from("flow_notifications").update({ read_at: new Date().toISOString() })
          .eq("user_id", state.session.user.id).is("read_at", null),
        "marcar todas as notificações"
      );
    },
    async excluir(id) {
      if (!state.session) return { data: null, error: "Entre novamente para continuar." };
      return chamar(
        client.from("flow_notifications").delete()
          .eq("id", id).eq("user_id", state.session.user.id),
        "excluir notificação"
      );
    },
    async excluirTodas() {
      if (!state.session) return { data: null, error: "Entre novamente para continuar." };
      return chamar(
        client.from("flow_notifications").delete().eq("user_id", state.session.user.id),
        "excluir todas as notificações"
      );
    },
    assinar(fn) {
      if (!state.session || typeof fn !== "function") return () => {};
      const userId = state.session.user.id;
      const canal = client.channel(`flow-notificacoes-${userId}`)
        .on("postgres_changes", {
          event: "INSERT", schema: "public", table: "flow_notifications", filter: `user_id=eq.${userId}`,
        }, (evento) => fn(evento.new || {}))
        .subscribe();
      return () => { client.removeChannel(canal); };
    },
  };

  const usuarios = {
    /**
     * Só quem pode ser responsável: perfil ativo com papel de equipe.
     *
     * Serve à sugestão de nomes na ficha, e é o mesmo recorte que
     * `flow_resolve_owner_profile` usa no banco para transformar o nome
     * escolhido em pessoa. Oferecer na tela alguém que o banco não resolveria
     * faria a atribuição parecer feita e o aviso não ter destino.
     */
    async equipe() {
      return chamar(
        client.from("flow_profiles")
          .select("id,full_name,email,area,role")
          .eq("active", true)
          .in("role", ["operador", "administrador", "proprietario"])
          .order("full_name", { ascending: true }),
        "listar a equipe"
      );
    },
    async listar() {
      return chamar(
        client.from("flow_profiles").select("*").order("full_name", { ascending: true }),
        "listar usuários"
      );
    },
    async definirPapel(userId, papel) {
      return chamar(
        client.rpc("flow_set_user_role", { target_user: userId, new_role: papel }),
        "definir papel"
      );
    },
    async ativar(userId, ativo) {
      return chamar(
        client.rpc("flow_set_user_active", { target_user: userId, p_active: Boolean(ativo) }),
        "ativar usuário"
      );
    },
  };

  // ---------------------------------------------------------------------------
  // Acesso — quem pode entrar e com que papel
  // ---------------------------------------------------------------------------
  const acesso = {
    /** Domínios de e-mail autorizados a se cadastrar. */
    async dominios() {
      const { data, error } = await chamar(
        client.from("flow_settings").select("value").eq("key", "acesso").maybeSingle(),
        "carregar domínios"
      );
      if (error) return { data: [], error };
      const lista = data && data.value ? data.value.dominios : [];
      return { data: Array.isArray(lista) ? lista : [], error: null };
    },

    async definirDominios(lista) {
      return chamar(
        client.rpc("flow_definir_dominios", { p_dominios: lista || [] }),
        "salvar domínios"
      );
    },

    /** Lista de e-mails da equipe. Só administrador enxerga. */
    async listar() {
      return chamar(
        client.from("flow_access_allowlist").select("*").order("email", { ascending: true }),
        "listar acessos"
      );
    },

    /**
     * Autoriza um e-mail com um papel. Se a pessoa já tem conta, o banco a
     * promove na mesma chamada — não é preciso pedir que ela recrie o cadastro.
     */
    async definir(email, papel, nota) {
      return chamar(
        client.rpc("flow_definir_acesso", {
          p_email: texto(email), p_role: papel || "operador", p_note: texto(nota),
        }),
        "autorizar e-mail"
      );
    },

    /** Tira da lista. Não rebaixa quem já entrou — isso é ato explícito. */
    async remover(email) {
      return chamar(
        client.rpc("flow_remover_acesso", { p_email: texto(email) }),
        "remover autorização"
      );
    },
  };

  const exportacao = {
    /** Linhas cruas da exportação. A montagem das colunas fica em flow_export.js. */
    async linhas(filtros = {}) {
      let consulta = client.from("flow_export_view").select("*").order("protocol", { ascending: true });
      if (filtros.tipo) consulta = consulta.eq("type_code", filtros.tipo);
      if (filtros.status) consulta = consulta.eq("request_status", filtros.status);
      if (filtros.responsavel) consulta = consulta.eq("owner_name", filtros.responsavel);
      if (filtros.solicitante) consulta = consulta.eq("requester_name", filtros.solicitante);
      if (filtros.classificacao) consulta = consulta.eq("classification", filtros.classificacao);
      if (filtros.origem) consulta = consulta.eq("request_origin", filtros.origem);
      if (filtros.de) consulta = consulta.gte("received_at", filtros.de);
      if (filtros.ate) consulta = consulta.lte("received_at", `${filtros.ate}T23:59:59`);
      if (filtros.abertas) consulta = consulta.not("request_status", "in", "(concluido,cancelado)");
      if (filtros.concluidas) consulta = consulta.eq("request_status", "concluido");
      if (Array.isArray(filtros.protocolos) && filtros.protocolos.length) {
        consulta = consulta.in("protocol", filtros.protocolos);
      }
      return chamar(consulta.limit(20000), "carregar linhas da exportação");
    },
  };

  root.FlowApi = Object.freeze({
    client, config, auth, tipos, modelosRapidos, solicitacoes, itens, triagem, lds, normas,
    comentarios, anexos, armazenamento, historico, notificacoes, usuarios, acesso, exportacao,
    ORDENS_DE_SOLICITACAO,
  });
})(window);
