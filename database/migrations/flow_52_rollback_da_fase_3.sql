-- GRCON Flow 52 — desfazimento da limpeza da Fase 3.
--
-- Este arquivo NÃO é uma migração: é o caminho de volta de
-- `flow_52_limpeza_da_fase_3.sql`, versionado junto para que a remoção nunca
-- seja irreversível. Só rode se a limpeza já tiver sido aplicada e for preciso
-- restaurar o estado anterior.
--
-- Como as duas tabelas estavam vazias quando a limpeza foi aplicada (a própria
-- migração recusa aplicar se não estiverem), recriar a estrutura restaura o
-- estado por completo — não há dado a repor.
--
-- ANTES DE APLICAR A LIMPEZA, guarde também o corpo das funções:
--
--   select pg_get_functiondef(p.oid)
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('flow_convert_external_inbox','flow_discard_external_inbox',
--                        'flow_redact_external_inbox_batch','flow_register_outlook_bridge',
--                        'flow_list_outlook_bridges','flow_revoke_outlook_bridge');
--
-- A definição original também está no histórico do git, nas migrações removidas
-- pelo commit `0dfddb7`:
--
--   git show 25bb638:database/migrations/flow_43_external_inbox_phase_3.sql
--   git show 25bb638:database/migrations/flow_44_external_inbox_review_index.sql
--   git show 877c72f:database/migrations/flow_46_outlook_local_bridge.sql
--   git show 877c72f:database/migrations/flow_47_outlook_bridge_created_by_index.sql

begin;

-- ---------------------------------------------------------------------------
-- Caixa de entrada externa
-- ---------------------------------------------------------------------------
create table if not exists public.flow_external_inbox (
  id uuid not null default gen_random_uuid(),
  source text not null,
  external_id text not null,
  idempotency_key text not null,
  sender_name text not null default ''::text,
  sender_email text not null,
  subject text not null default ''::text,
  body_text text not null default ''::text,
  received_at timestamptz not null default now(),
  submitted_by_email text not null,
  message_url text not null default ''::text,
  attachment_count integer not null default 0,
  attachment_metadata jsonb not null default '[]'::jsonb,
  status text not null default 'novo'::text,
  request_id uuid,
  reviewed_by uuid,
  reviewed_at timestamptz,
  discarded_reason text not null default ''::text,
  body_redacted_at timestamptz,
  payload_version smallint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint flow_external_inbox_pkey primary key (id),
  constraint flow_external_inbox_idempotency_key_key unique (idempotency_key),
  constraint flow_external_inbox_source_external_id_key unique (source, external_id),
  constraint flow_external_inbox_request_id_fkey
    foreign key (request_id) references public.flow_requests(id) on delete set null,
  constraint flow_external_inbox_reviewed_by_fkey
    foreign key (reviewed_by) references auth.users(id) on delete set null,
  constraint flow_external_inbox_source_check
    check (source = any (array['outlook'::text, 'teams'::text])),
  constraint flow_external_inbox_status_check
    check (status = any (array['novo'::text, 'em_revisao'::text, 'convertido'::text, 'descartado'::text, 'erro'::text])),
  constraint flow_external_inbox_idempotency_key_check
    check (idempotency_key ~ '^[0-9a-f]{64}$'),
  constraint flow_external_inbox_external_id_check
    check (char_length(external_id) >= 1 and char_length(external_id) <= 1000),
  constraint flow_external_inbox_sender_name_check
    check (char_length(sender_name) <= 160),
  constraint flow_external_inbox_sender_email_check
    check (char_length(sender_email) <= 254
           and sender_email = lower(btrim(sender_email))
           and sender_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  constraint flow_external_inbox_submitted_by_email_check
    check (char_length(submitted_by_email) <= 254
           and submitted_by_email = lower(btrim(submitted_by_email))
           and submitted_by_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  constraint flow_external_inbox_subject_check check (char_length(subject) <= 500),
  constraint flow_external_inbox_body_text_check check (char_length(body_text) <= 20000),
  constraint flow_external_inbox_message_url_check check (char_length(message_url) <= 2000),
  constraint flow_external_inbox_discarded_reason_check check (char_length(discarded_reason) <= 500),
  constraint flow_external_inbox_attachment_count_check
    check (attachment_count >= 0 and attachment_count <= 30),
  constraint flow_external_inbox_attachment_metadata_check
    check (jsonb_typeof(attachment_metadata) = 'array'),
  constraint flow_external_inbox_payload_version_check
    check (payload_version >= 1 and payload_version <= 10)
);

create index if not exists flow_external_inbox_status_received_idx
  on public.flow_external_inbox (status, received_at desc);
create index if not exists flow_external_inbox_request_idx
  on public.flow_external_inbox (request_id) where request_id is not null;
create index if not exists flow_external_inbox_reviewed_by_idx
  on public.flow_external_inbox (reviewed_by) where reviewed_by is not null;
create index if not exists flow_external_inbox_submitter_idx
  on public.flow_external_inbox (submitted_by_email, received_at desc);
create index if not exists flow_external_inbox_redaction_idx
  on public.flow_external_inbox (reviewed_at)
  where body_redacted_at is null and status = any (array['convertido'::text, 'descartado'::text]);

alter table public.flow_external_inbox enable row level security;
revoke all on table public.flow_external_inbox from public, anon, authenticated;
grant select on table public.flow_external_inbox to authenticated;

drop policy if exists flow_external_inbox_staff_select on public.flow_external_inbox;
create policy flow_external_inbox_staff_select
  on public.flow_external_inbox for select to authenticated
  using ((select public.flow_is_staff()));

-- ---------------------------------------------------------------------------
-- Segredos da ponte local
-- ---------------------------------------------------------------------------
create table if not exists public.flow_external_webhook_secrets (
  name text not null,
  secret_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  rotated_at timestamptz not null default now(),
  bridge_id uuid,
  kind text not null default 'legacy'::text,
  label text not null default ''::text,
  submitted_by_email text,
  created_by uuid,
  last_used_at timestamptz,
  last_result text not null default ''::text,
  last_error text not null default ''::text,
  revoked_at timestamptz,
  constraint flow_external_webhook_secrets_pkey primary key (name),
  constraint flow_external_webhook_secrets_created_by_fkey
    foreign key (created_by) references auth.users(id) on delete set null,
  constraint flow_external_webhook_secrets_secret_hash_check
    check (secret_hash ~ '^[0-9a-f]{64}$'),
  constraint flow_external_webhook_secrets_kind_check
    check (kind = any (array['legacy'::text, 'outlook_local'::text])),
  constraint flow_external_webhook_secrets_label_check check (char_length(label) <= 120),
  constraint flow_external_webhook_secrets_last_result_check check (char_length(last_result) <= 80),
  constraint flow_external_webhook_secrets_last_error_check check (char_length(last_error) <= 300),
  constraint flow_external_webhook_secrets_submitter_check
    check (submitted_by_email is null
           or (submitted_by_email = lower(btrim(submitted_by_email))
               and char_length(submitted_by_email) <= 254
               and submitted_by_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'))
);

create index if not exists flow_external_webhook_secrets_created_by_idx
  on public.flow_external_webhook_secrets (created_by);
create index if not exists flow_external_webhook_secrets_bridge_idx
  on public.flow_external_webhook_secrets (bridge_id) where bridge_id is not null;

-- Sem policy, de propósito: RLS ligada e nenhuma política significa negação
-- total. Só funções `security definer` alcançam a tabela.
alter table public.flow_external_webhook_secrets enable row level security;
revoke all on table public.flow_external_webhook_secrets from public, anon, authenticated;

commit;

-- As seis funções precisam ser recriadas a partir do texto guardado antes da
-- limpeza (ou do histórico do git indicado no cabeçalho). A estrutura acima é
-- pré-requisito delas, não substituto.
