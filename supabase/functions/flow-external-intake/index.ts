import "jsr:@supabase/functions-js@2.4.4/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const MAX_BATCH = 100;
const MAX_BODY_BYTES = 2_500_000;
const MAX_MESSAGE_CHARS = 20_000;
const STAFF_ROLES = ["operador", "administrador", "proprietario"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type UnknownRecord = Record<string, unknown>;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function value(input: unknown, max = 20_000) {
  return String(input ?? "").trim().slice(0, max);
}

function email(input: unknown) {
  const normalized = value(input, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : "";
}

function decodeEntities(input: string) {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => {
      const point = Number(code);
      return String.fromCodePoint(Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? point : 32);
    });
}

function plainText(input: unknown) {
  return decodeEntities(value(input, MAX_MESSAGE_CHARS * 3)
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);
}

function serviceKey() {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}") as Record<string, string>;
    return keys.default || Object.values(keys)[0] || "";
  } catch {
    return "";
  }
}

async function sha256(input: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function asRecord(input: unknown): UnknownRecord {
  return input && typeof input === "object" && !Array.isArray(input) ? input as UnknownRecord : {};
}

function attachmentMetadata(input: unknown) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 30).map((raw) => {
    const item = asRecord(raw);
    return {
      id: value(item.id ?? item.attachment_id, 500),
      name: value(item.name ?? item.file_name, 260),
      content_type: value(item.content_type ?? item.contentType, 160),
      size: Math.max(0, Number(item.size ?? item.size_bytes) || 0),
      inline: Boolean(item.inline ?? item.isInline),
    };
  }).filter((item) => item.name && !item.inline);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL") || "";
    const key = serviceKey();
    if (!url || !key) return json({ error: "service_not_configured" }, 500);

    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const providedBridgeId = value(req.headers.get("x-grcon-flow-bridge-id"), 36).toLowerCase();
    const providedSecret = value(req.headers.get("x-grcon-flow-secret"), 512);
    if (!UUID_PATTERN.test(providedBridgeId) || !providedSecret) {
      return json({ error: "unauthorized" }, 401);
    }
    const providedHash = await sha256(providedSecret);
    const { data: secret, error: secretError } = await supabase
      .from("flow_external_webhook_secrets")
      .select("secret_hash,active,submitted_by_email,kind")
      .eq("bridge_id", providedBridgeId)
      .eq("kind", "outlook_local")
      .eq("active", true)
      .maybeSingle();
    if (secretError || !secret || !safeEqual(providedHash, String(secret.secret_hash || ""))) {
      return json({ error: "unauthorized" }, 401);
    }
    const markBridge = async (result: string, error = "") => {
      const { error: markError } = await supabase
        .from("flow_external_webhook_secrets")
        .update({
          last_used_at: new Date().toISOString(),
          last_result: value(result, 80),
          last_error: value(error, 300),
        })
        .eq("bridge_id", providedBridgeId)
        .eq("active", true);
      if (markError) console.error(JSON.stringify({ event: "outlook_bridge_mark_failed" }));
    };

    const rawBody = await req.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return json({ error: "payload_too_large", max_batch: MAX_BATCH }, 413);
    }
    let payload: UnknownRecord;
    try {
      payload = asRecord(JSON.parse(rawBody));
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const source = value(payload.source, 20).toLowerCase();
    if (source !== "outlook") {
      await markBridge("erro", "invalid_source");
      return json({ error: "invalid_source" }, 422);
    }
    const submittedBy = email(payload.submitted_by_email ?? payload.submittedByEmail);
    if (!submittedBy || submittedBy !== String(secret.submitted_by_email || "")) {
      await markBridge("erro", "submitter_mismatch");
      return json({ error: "invalid_submitter_email" }, 422);
    }

    const { data: staff, error: staffError } = await supabase
      .from("flow_profiles")
      .select("id")
      .eq("email", submittedBy)
      .eq("active", true)
      .in("role", STAFF_ROLES)
      .maybeSingle();
    if (staffError || !staff) {
      await markBridge("erro", "submitter_not_authorized");
      return json({ error: "submitter_not_authorized" }, 403);
    }

    if (value(payload.action, 20).toLowerCase() === "health") {
      await markBridge("conectada");
      return json({ ok: true, bridge_id: providedBridgeId, status: "connected" });
    }

    const items = Array.isArray(payload.items) ? payload.items : [payload.item ?? payload];
    if (!items.length) return json({ error: "empty_batch" }, 422);
    if (items.length > MAX_BATCH) return json({ error: "batch_too_large", max_batch: MAX_BATCH }, 413);

    const errors: Array<{ index: number; external_id: string; source_item_id: string; error: string }> = [];
    const rows: UnknownRecord[] = [];
    const sourceItemIds = new Map<string, string>();
    for (let index = 0; index < items.length; index += 1) {
      const item = asRecord(items[index]);
      const externalId = value(
        item.external_id ?? item.internet_message_id ?? item.internetMessageId ?? item.message_id ?? item.id,
        1000,
      );
      const sender = asRecord(item.sender ?? item.from);
      const senderAddress = asRecord(sender.emailAddress);
      const sourceItemId = value(item.source_item_id ?? item.message_id ?? item.id, 1000);
      const senderEmail = email(
        item.sender_email ?? item.senderEmail ?? sender.address ?? sender.email ?? senderAddress.address,
      );
      if (!externalId || !senderEmail) {
        errors.push({
          index,
          external_id: externalId,
          source_item_id: sourceItemId,
          error: !externalId ? "missing_external_id" : "missing_sender_email",
        });
        continue;
      }
      const senderName = value(
        item.sender_name ?? item.senderName ?? sender.name ?? senderAddress.name,
        160,
      );
      const body = asRecord(item.body);
      const attachments = attachmentMetadata(item.attachments);
      const idempotencyKey = await sha256(`${source}\u0000${externalId}`);
      sourceItemIds.set(idempotencyKey, sourceItemId);
      const receivedCandidate = value(item.received_at ?? item.receivedDateTime, 80);
      const receivedDate = new Date(receivedCandidate);
      rows.push({
        source,
        external_id: externalId,
        idempotency_key: idempotencyKey,
        sender_name: senderName,
        sender_email: senderEmail,
        subject: value(item.subject, 500),
        body_text: plainText(item.body_text ?? item.bodyPreview ?? body.content ?? item.body),
        received_at: Number.isNaN(receivedDate.getTime()) ? new Date().toISOString() : receivedDate.toISOString(),
        submitted_by_email: submittedBy,
        message_url: value(item.message_url ?? item.webLink, 2000),
        attachment_count: Math.min(30, Math.max(attachments.length, Number(item.attachment_count) || 0)),
        attachment_metadata: attachments,
        payload_version: 1,
      });
    }

    if (!rows.length) {
      await markBridge("lote_invalido", `${errors.length} item(ns) inválido(s)`);
      return json({ ok: true, received: items.length, accepted: 0, duplicates: 0, errors, items: [] });
    }
    const keys = rows.map((row) => String(row.idempotency_key));
    const { data: before, error: beforeError } = await supabase
      .from("flow_external_inbox")
      .select("id,idempotency_key,status,request_id")
      .in("idempotency_key", keys);
    if (beforeError) return json({ error: "database_read_failed" }, 500);
    const previousKeys = new Set((before || []).map((row) => row.idempotency_key));

    const { error: insertError } = await supabase
      .from("flow_external_inbox")
      .upsert(rows, { onConflict: "source,external_id", ignoreDuplicates: true });
    if (insertError) return json({ error: "database_write_failed" }, 500);

    const { data: saved, error: savedError } = await supabase
      .from("flow_external_inbox")
      .select("id,external_id,idempotency_key,status,request_id")
      .in("idempotency_key", keys);
    if (savedError) return json({ error: "database_receipt_failed" }, 500);

    const results = (saved || []).map((row) => ({
      id: row.id,
      external_id: row.external_id,
      status: row.status,
      request_id: row.request_id,
      source_item_id: sourceItemIds.get(row.idempotency_key) || "",
      duplicate: previousKeys.has(row.idempotency_key),
    }));
    const duplicates = results.filter((item) => item.duplicate).length;
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { error: redactionError } = await supabase.rpc("flow_redact_external_inbox_batch", {
      p_cutoff: cutoff,
      p_limit: 200,
    });
    if (redactionError) console.error(JSON.stringify({ event: "external_inbox_redaction_failed" }));
    await markBridge("processado", errors.length ? `${errors.length} item(ns) inválido(s)` : "");
    console.log(JSON.stringify({ event: "external_inbox_batch", source, received: items.length, accepted: results.length - duplicates, duplicates, errors: errors.length }));
    return json({
      ok: true,
      received: items.length,
      accepted: results.length - duplicates,
      duplicates,
      errors,
      items: results,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "external_inbox_error", message: error instanceof Error ? error.message : "unknown" }));
    return json({ error: "internal_error" }, 500);
  }
});
