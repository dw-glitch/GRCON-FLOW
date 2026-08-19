/**
 * GRCON — persistência independente da Operação de Solicitações.
 *
 * Não contém URL, chave, tabela, RPC ou workspace do banco do GRCON original.
 * O módulo depende somente desta interface. O driver padrão é localStorage;
 * quando uma nova instância Supabase for configurada, o driver "supabase"
 * usa exclusivamente o schema `sol_*` documentado em database/schema.sql.
 */
(function (root) {
  "use strict";

  const config = root.GRCON_SOLICITACOES_CONFIG || {};
  const prefix = "grcon.solicitacoes.standalone.v1";
  const workspaceId = String(config.workspaceId || "default");
  const role = ["owner", "admin", "operator", "viewer"].includes(config.role) ? config.role : "owner";

  const state = {
    driver: String(config.storageDriver || "local").toLowerCase(),
    membership: { workspace_id: workspaceId, role },
    client: null,
    online: true,
    error: ""
  };

  const text = (value) => value === null || value === undefined ? "" : String(value).trim();
  const nowIso = () => new Date().toISOString();
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const canWrite = () => ["owner", "admin", "operator"].includes(state.membership?.role);
  const canManageMembers = () => state.membership?.role === "owner";

  function readLocal(name, fallback) {
    try {
      const raw = localStorage.getItem(`${prefix}.${workspaceId}.${name}`);
      return raw ? JSON.parse(raw) : clone(fallback);
    } catch (_) {
      return clone(fallback);
    }
  }
  function writeLocal(name, value) {
    localStorage.setItem(`${prefix}.${workspaceId}.${name}`, JSON.stringify(value));
  }

  function defaultTypes() {
    const core = root.GrconRequestsCore;
    return core && core.requestTypeList ? core.requestTypeList(null) : [];
  }

  function ensureLocalSeed() {
    const current = readLocal("types", null);
    if (!Array.isArray(current)) writeLocal("types", defaultTypes());
    if (!Array.isArray(readLocal("requests", null))) writeLocal("requests", []);
    if (!Array.isArray(readLocal("items", null))) writeLocal("items", []);
    if (!Array.isArray(readLocal("history", null))) writeLocal("history", []);
  }

  function historyEvent(protocol, action, field, oldValue, newValue, note) {
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      protocol: text(protocol),
      action: text(action) || "updated",
      field: text(field),
      old_value: oldValue === null || oldValue === undefined ? "" : String(oldValue),
      new_value: newValue === null || newValue === undefined ? "" : String(newValue),
      note: text(note),
      created_at: nowIso()
    };
  }

  const localDriver = {
    async getRequestTypes() {
      ensureLocalSeed();
      return readLocal("types", defaultTypes());
    },
    async saveRequestType(tipo) {
      if (!canManageMembers()) return { ok: false, error: "Somente o proprietário pode configurar os tipos de solicitação." };
      if (!tipo || !text(tipo.label)) return { ok: false, error: "O tipo precisa de um nome." };
      const core = root.GrconRequestsCore;
      const normalized = core?.normalizeRequestType ? core.normalizeRequestType(tipo) : tipo;
      if (!normalized) return { ok: false, error: "Tipo de solicitação inválido." };
      const types = readLocal("types", defaultTypes());
      const index = types.findIndex((item) => item.code === normalized.code);
      if (index >= 0) types[index] = normalized; else types.push(normalized);
      writeLocal("types", types);
      return { ok: true };
    },
    async deleteRequestType(code) {
      if (!canManageMembers()) return { ok: false, error: "Somente o proprietário pode configurar os tipos de solicitação." };
      const target = text(code);
      const types = readLocal("types", defaultTypes());
      const items = readLocal("items", []);
      const used = items.filter((item) => item.type_code === target).length;
      const index = types.findIndex((item) => item.code === target);
      if (index < 0) return { ok: true, detalhe: "já não existia" };
      if (used) {
        types[index] = { ...types[index], active: false };
        writeLocal("types", types);
        return { ok: true, detalhe: `desativado; ${used} item(ns) antigo(s) preservado(s)` };
      }
      types.splice(index, 1);
      writeLocal("types", types);
      return { ok: true, detalhe: "removido" };
    },
    async listRequestItems() {
      ensureLocalSeed();
      const requests = readLocal("requests", []);
      const requestMap = new Map(requests.map((request) => [request.id, request]));
      return readLocal("items", []).map((item) => {
        const request = requestMap.get(item.request_id) || {};
        return {
          ...item,
          request_number: request.request_number || "",
          requester: request.requester || "",
          received_at: request.received_at || ""
        };
      }).sort((a, b) => Number(b.item_number || 0) - Number(a.item_number || 0));
    },
    async saveRequest(header, items) {
      if (!canWrite()) return { ok: false, error: "Seu perfil é somente de consulta." };
      const list = Array.isArray(items) ? items : [];
      if (!list.length) return { ok: false, error: "Nenhum item para gravar." };
      const protocols = list.map((item) => text(item.item || item.protocol)).filter(Boolean);
      if (new Set(protocols).size !== protocols.length) return { ok: false, error: "A solicitação contém protocolos repetidos." };
      const existing = readLocal("items", []);
      const existingProtocols = new Set(existing.map((item) => text(item.protocol)));
      const duplicate = protocols.find((protocol) => existingProtocols.has(protocol));
      if (duplicate) return { ok: false, error: `O item ${duplicate} já está registrado. A solicitação não foi salva.` };

      const requests = readLocal("requests", []);
      const requestId = root.crypto?.randomUUID ? root.crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      requests.push({
        id: requestId,
        request_number: text(header?.requestNumber),
        received_at: text(header?.receivedAtIso),
        requester: text(header?.requester),
        owner_name: text(header?.owner),
        notes: text(header?.notes),
        status: text(header?.status) || "recebido",
        created_at: nowIso(),
        updated_at: nowIso()
      });

      const history = readLocal("history", []);
      list.forEach((item) => {
        const protocol = text(item.item || item.protocol);
        existing.push({
          id: root.crypto?.randomUUID ? root.crypto.randomUUID() : `item-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          request_id: requestId,
          item_number: Number(item.itemNumber) || Number(item.item) || null,
          protocol,
          document: text(item.document),
          requested_title: text(item.requestedTitle || item._requestedTitle),
          official_title: text(item.officialTitle || item._ldTitle),
          type_code: text(item.requestType),
          owner_name: text(item.owner),
          status: text(item.itemStatus) || "recebido",
          classification: text(item._classification),
          recommended_action: text(item.recommendedAction),
          reason: text(item.observations),
          ld_name: text(item.reference || item._ld),
          all_lds: text(item.allLds),
          allocation: text(item.allocation),
          allocation_status: text(item.needsLdInclusion),
          last_grdt: text(item.lastGrdt),
          sigem_status: text(item.sigemStatus),
          revision: text(item.revision),
          needs_manual_validation: Boolean(item._needsManualValidation),
          observations: text(item.observations),
          created_at: nowIso(),
          updated_at: nowIso()
        });
        history.push(historyEvent(protocol, "saved", "", "", "", ""));
      });

      writeLocal("requests", requests);
      writeLocal("items", existing);
      writeLocal("history", history);
      return { ok: true, id: requestId };
    },
    async updateRequestItems(protocols, field, value, note) {
      if (!canWrite()) return { ok: false, error: "Seu perfil é somente de consulta." };
      const targets = new Set((protocols || []).map(text));
      const allowed = new Set(["status", "owner_name", "type_code", "priority", "deadline", "observations", "classification", "needs_manual_validation"]);
      if (!allowed.has(field)) return { ok: false, error: "Campo não permitido para atualização." };
      const items = readLocal("items", []);
      const history = readLocal("history", []);
      let changed = 0;
      items.forEach((item) => {
        if (!targets.has(text(item.protocol))) return;
        const old = item[field];
        const next = field === "needs_manual_validation" ? Boolean(value) : value;
        if (String(old ?? "") === String(next ?? "")) return;
        item[field] = next;
        item.updated_at = nowIso();
        history.push(historyEvent(item.protocol, "updated", field, old, next, note));
        changed += 1;
      });
      writeLocal("items", items);
      writeLocal("history", history);
      return { ok: true, changed };
    },
    async requestItemHistory(protocol) {
      return readLocal("history", [])
        .filter((event) => text(event.protocol) === text(protocol))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    }
  };

  function supabaseClient() {
    if (state.client) return state.client;
    if (!root.supabase?.createClient) throw new Error("Cliente Supabase não carregado.");
    if (!text(config.supabaseUrl) || !text(config.supabaseAnonKey)) throw new Error("Configure SUPABASE_URL e SUPABASE_ANON_KEY do novo projeto.");
    state.client = root.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    return state.client;
  }

  const supabaseDriver = {
    async getRequestTypes() {
      const client = supabaseClient();
      const { data, error } = await client.from("sol_request_types").select("*").eq("workspace_id", workspaceId).order("display_order");
      if (error) throw error;
      return (data || []).map((row) => ({
        code: row.code, label: row.label, description: row.description || "", defaultAction: row.default_action || "",
        defaultPriority: row.default_priority || "normal", defaultDeadlineDays: row.default_deadline_days,
        requiredFields: row.required_fields || [], active: row.active, order: row.display_order || 0
      }));
    },
    async saveRequestType(type) {
      if (!canManageMembers()) return { ok: false, error: "Somente o proprietário pode configurar os tipos de solicitação." };
      const normalized = root.GrconRequestsCore?.normalizeRequestType(type);
      if (!normalized) return { ok: false, error: "Tipo de solicitação inválido." };
      const client = supabaseClient();
      const { error } = await client.from("sol_request_types").upsert({
        workspace_id: workspaceId, code: normalized.code, label: normalized.label, description: normalized.description,
        default_action: normalized.defaultAction, default_priority: normalized.defaultPriority,
        default_deadline_days: normalized.defaultDeadlineDays, required_fields: normalized.requiredFields,
        active: normalized.active, display_order: normalized.order
      }, { onConflict: "workspace_id,code" });
      return error ? { ok: false, error: error.message } : { ok: true };
    },
    async deleteRequestType(code) {
      if (!canManageMembers()) return { ok: false, error: "Somente o proprietário pode configurar os tipos de solicitação." };
      const client = supabaseClient();
      const { count, error: countError } = await client.from("sol_request_items").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("type_code", text(code));
      if (countError) return { ok: false, error: countError.message };
      if (count) {
        const { error } = await client.from("sol_request_types").update({ active: false }).eq("workspace_id", workspaceId).eq("code", text(code));
        return error ? { ok: false, error: error.message } : { ok: true, detalhe: `desativado; ${count} item(ns) antigo(s) preservado(s)` };
      }
      const { error } = await client.from("sol_request_types").delete().eq("workspace_id", workspaceId).eq("code", text(code));
      return error ? { ok: false, error: error.message } : { ok: true, detalhe: "removido" };
    },
    async listRequestItems() {
      const client = supabaseClient();
      const { data, error } = await client.from("sol_request_items")
        .select("*, sol_requests!inner(request_number, requester, received_at)")
        .eq("workspace_id", workspaceId).order("item_number", { ascending: false });
      if (error) throw error;
      return (data || []).map((row) => ({ ...row, request_number: row.sol_requests?.request_number || "", requester: row.sol_requests?.requester || "", received_at: row.sol_requests?.received_at || "" }));
    },
    async saveRequest(header, items) {
      if (!canWrite()) return { ok: false, error: "Seu perfil é somente de consulta." };
      const client = supabaseClient();
      const { data, error } = await client.rpc("sol_save_request_bundle", {
        target_workspace: workspaceId,
        request_payload: {
          request_number: text(header?.requestNumber), received_at: text(header?.receivedAtIso), requester: text(header?.requester),
          owner_name: text(header?.owner), notes: text(header?.notes), status: text(header?.status) || "recebido"
        },
        items_payload: (items || []).map((item) => ({
          item_number: Number(item.itemNumber) || Number(item.item) || null, protocol: text(item.item || item.protocol), document: text(item.document),
          requested_title: text(item.requestedTitle || item._requestedTitle), official_title: text(item.officialTitle || item._ldTitle),
          type_code: text(item.requestType), owner_name: text(item.owner), status: text(item.itemStatus) || "recebido",
          classification: text(item._classification), recommended_action: text(item.recommendedAction), reason: text(item.observations),
          ld_name: text(item.reference || item._ld), all_lds: text(item.allLds), allocation: text(item.allocation),
          allocation_status: text(item.needsLdInclusion), last_grdt: text(item.lastGrdt), sigem_status: text(item.sigemStatus),
          revision: text(item.revision), needs_manual_validation: Boolean(item._needsManualValidation), observations: text(item.observations)
        }))
      });
      return error ? { ok: false, error: error.message } : { ok: true, id: data };
    },
    async updateRequestItems(protocols, field, value, note) {
      if (!canWrite()) return { ok: false, error: "Seu perfil é somente de consulta." };
      const client = supabaseClient();
      const { data, error } = await client.rpc("sol_update_request_items", {
        target_workspace: workspaceId, target_protocols: protocols || [], field_name: field,
        new_value: value === null || value === undefined ? "" : String(value), note: text(note)
      });
      return error ? { ok: false, error: error.message } : { ok: true, changed: Number(data) || 0 };
    },
    async requestItemHistory(protocol) {
      const client = supabaseClient();
      const { data, error } = await client.from("sol_request_history").select("*").eq("workspace_id", workspaceId).eq("protocol", text(protocol)).order("created_at", { ascending: false });
      if (error) throw error;
      return data || [];
    }
  };

  function driver() { return state.driver === "supabase" ? supabaseDriver : localDriver; }
  async function safeCall(name, args, fallback) {
    try {
      const result = await driver()[name](...(args || []));
      state.online = true; state.error = "";
      return result;
    } catch (error) {
      state.online = false; state.error = error?.message || String(error);
      console.error(`[GRCON Solicitações] ${name}:`, error);
      return typeof fallback === "function" ? fallback(error) : fallback;
    }
  }

  const api = {
    state,
    canManageMembers,
    getRequestTypes: () => safeCall("getRequestTypes", [], []),
    saveRequestType: (type) => safeCall("saveRequestType", [type], (e) => ({ ok: false, error: e.message })),
    deleteRequestType: (code) => safeCall("deleteRequestType", [code], (e) => ({ ok: false, error: e.message })),
    listRequestItems: () => safeCall("listRequestItems", [], []),
    saveRequest: (header, items) => safeCall("saveRequest", [header, items], (e) => ({ ok: false, error: e.message })),
    updateRequestItems: (protocols, field, value, note) => safeCall("updateRequestItems", [protocols, field, value, note], (e) => ({ ok: false, error: e.message })),
    requestItemHistory: (protocol) => safeCall("requestItemHistory", [protocol], []),
    init() {
      if (state.driver === "local") ensureLocalSeed();
      if (state.driver === "supabase") supabaseClient();
      return api;
    }
  };

  root.GrconSolicitacoesStorage = Object.freeze(api);
  api.init();
})(window);
