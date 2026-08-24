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

  const client = root.supabase.createClient(config.supabaseUrl, config.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  const state = { session: null, profile: null };
  const ouvintes = new Set();

  function texto(valor) {
    return valor === null || valor === undefined ? "" : String(valor).trim();
  }

  // O bucket continua privado; esta lista define o contrato do formulário.
  // A extensão é a fonte mais estável aqui porque alguns navegadores não
  // informam o MIME de arquivos do Office (ou informam application/octet-stream).
  const EXTENSOES_ANEXO = Object.freeze(["pdf", "xls", "xlsx", "xlsm", "doc", "docx"]);
  const ACEITE_ANEXO = EXTENSOES_ANEXO.map((extensao) => `.${extensao}`).join(",");
  const MAXIMO_ANEXOS = Math.min(5, Math.max(1, Number(config.uploadMaxFiles) || 5));
  const MIME_ANEXO = Object.freeze({
    pdf: "application/pdf",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xlsm: "application/vnd.ms-excel.sheet.macroenabled.12",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });

  function extensaoDoAnexo(arquivo) {
    return texto(arquivo && arquivo.name).toLowerCase().split(".").pop();
  }

  function validarAnexo(arquivo) {
    if (!arquivo || !texto(arquivo.name)) return "Escolha um arquivo válido.";
    const extensao = extensaoDoAnexo(arquivo);
    if (!EXTENSOES_ANEXO.includes(extensao)) {
      return `“${arquivo.name}” não é PDF, Excel ou Word.`;
    }
    if (!Number(arquivo.size)) return `“${arquivo.name}” está vazio.`;
    const limiteMb = config.uploadMaxMb || 10;
    if (arquivo.size > limiteMb * 1024 * 1024) {
      return `“${arquivo.name}” tem mais de ${limiteMb} MB.`;
    }
    return null;
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
    if (/LI\/MC.*N-1710|PDF e o Excel|PDF \+ Excel|PDF obrigatório|Excel obrigatório/i.test(bruto)) return bruto;
    if (/Limite de 5 anexos complementares/i.test(bruto)) return "Esta solicitação já tem o limite de 5 anexos complementares.";
    if (/Limite de 5 anexos/i.test(bruto)) return "Esta solicitação já tem o limite de 5 anexos.";
    if (/flow_attachments_(extension|mime)_valid|mime type|formato de anexo/i.test(bruto)) {
      return "Envie somente arquivos PDF, Word ou Excel.";
    }
    if (/flow_attachments_size_valid|maximum allowed size|mais de 10 MB/i.test(bruto)) {
      return "Cada anexo pode ter no máximo 10 MB.";
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

    ehEquipe() { return ["operador", "administrador", "proprietario"].includes(auth.role); },
    ehAdmin() { return ["administrador", "proprietario"].includes(auth.role); },
    ehProprietario() { return auth.role === "proprietario"; },

    aoMudar(fn) { ouvintes.add(fn); return () => ouvintes.delete(fn); },

    async iniciar() {
      const { data } = await client.auth.getSession();
      state.session = data ? data.session : null;
      await carregarPerfil();
      client.auth.onAuthStateChange(async (_evento, sessao) => {
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
      return { error };
    },

    async sair() {
      await client.auth.signOut();
      state.session = null;
      state.profile = null;
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
  // Solicitações
  // ---------------------------------------------------------------------------
  const solicitacoes = {
    /**
     * Registra a solicitação. O protocolo é gerado pelo banco, numa operação
     * atômica: dois envios simultâneos nunca recebem o mesmo número.
     */
    async criar(dados) {
      return chamar(
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
    },

    async listar(filtros = {}) {
      let consulta = client.from("flow_requests").select("*").order("created_at", { ascending: false });
      if (filtros.status) consulta = consulta.eq("status", filtros.status);
      if (filtros.tipo) consulta = consulta.eq("type_code", filtros.tipo);
      if (filtros.responsavel) consulta = consulta.eq("owner_name", filtros.responsavel);
      if (filtros.meus && state.session) consulta = consulta.eq("requester_id", state.session.user.id);
      if (filtros.de) consulta = consulta.gte("created_at", filtros.de);
      if (filtros.ate) consulta = consulta.lte("created_at", `${filtros.ate}T23:59:59`);
      if (filtros.abertas) consulta = consulta.not("status", "in", "(concluido,cancelado)");
      if (filtros.busca) {
        const termo = texto(filtros.busca).replace(/[%,()]/g, " ");
        consulta = consulta.or(
          `protocol.ilike.%${termo}%,requester_name.ilike.%${termo}%,summary.ilike.%${termo}%,type_label.ilike.%${termo}%`
        );
      }
      consulta = consulta.range(filtros.inicio || 0, (filtros.inicio || 0) + (filtros.limite || 100) - 1);
      return chamar(consulta, "listar solicitações");
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
      const [
        emAberto, hojeRecebidas, execucao, validacao, atrasadas, concluidas, semResponsavel,
        naoLocalizados, pendenteId, semAlocacao,
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
      ]);
      return {
        emAberto, hojeRecebidas, execucao, validacao, atrasadas, concluidas,
        semResponsavel, naoLocalizados, pendenteId, semAlocacao,
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
    /** Tria a solicitação inteira. Chamada logo após o envio. */
    async solicitacao(id) {
      return chamar(client.rpc("flow_triage_request", { target_request: id }), "executar triagem");
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

  const anexos = {
    extensoes: EXTENSOES_ANEXO,
    accept: ACEITE_ANEXO,
    maximo: MAXIMO_ANEXOS,
    validar: validarAnexo,

    async enviar(requestId, arquivo, itemId = null) {
      const erroArquivo = validarAnexo(arquivo);
      if (erroArquivo) return { data: null, error: erroArquivo };
      const nomeSeguro = arquivo.name.replace(/[^\w.\- ]+/g, "_");
      const identificador = root.crypto && typeof root.crypto.randomUUID === "function"
        ? root.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const caminho = `${requestId}/${identificador}-${nomeSeguro}`;
      const mimeType = MIME_ANEXO[extensaoDoAnexo(arquivo)];
      const { error } = await chamar(
        client.storage.from("flow-anexos").upload(caminho, arquivo, {
          contentType: mimeType,
          upsert: false,
        }),
        "enviar anexo"
      );
      if (error) return { error };
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
      const canal = client.channel(`flow-armazenamento-${sufixo}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "flow_attachments" }, fn)
        .on("postgres_changes", { event: "*", schema: "public", table: "flow_ld_versions" }, fn)
        .on("postgres_changes", { event: "*", schema: "public", table: "flow_norm_versions" }, fn)
        .subscribe();
      return () => { client.removeChannel(canal); };
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
    client, config, auth, tipos, solicitacoes, itens, triagem, lds, normas,
    comentarios, anexos, armazenamento, historico, notificacoes, usuarios, acesso, exportacao,
  });
})(window);
