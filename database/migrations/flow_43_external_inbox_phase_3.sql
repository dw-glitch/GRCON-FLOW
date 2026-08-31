-- GRCON Flow — Fase 3 do Registro rápido: entrada controlada por Outlook/Teams.
--
-- Mensagens externas viram rascunhos para revisão da Qualidade. Nenhuma
-- integração cria protocolo sozinha. O binário dos anexos continua fora do
-- Postgres; nesta tabela entram apenas texto curto, metadados e rastreabilidade.

begin;

-- Favoritos foram retirados por decisão operacional. A trava impede apagar
-- silenciosamente um modelo caso alguém o tenha criado entre a conferência e
-- a aplicação desta migração.
do $$
begin
  if to_regclass('public.flow_quick_templates') is not null
     and exists (select 1 from public.flow_quick_templates) then
    raise exception 'Existem favoritos salvos; preserve-os antes de remover a funcionalidade.';
  end if;
end;
$$;

drop table if exists public.flow_quick_templates cascade;
drop function if exists public.flow_validate_quick_template();

create table public.flow_external_inbox (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('outlook', 'teams')),
  external_id text not null check (char_length(external_id) between 1 and 1000),
  idempotency_key text not null check (idempotency_key ~ '^[0-9a-f]{64}$'),
  sender_name text not null default '' check (char_length(sender_name) <= 160),
  sender_email text not null check (
    char_length(sender_email) <= 254
    and sender_email = lower(btrim(sender_email))
    and sender_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  subject text not null default '' check (char_length(subject) <= 500),
  body_text text not null default '' check (char_length(body_text) <= 20000),
  received_at timestamptz not null default now(),
  submitted_by_email text not null check (
    char_length(submitted_by_email) <= 254
    and submitted_by_email = lower(btrim(submitted_by_email))
    and submitted_by_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  message_url text not null default '' check (char_length(message_url) <= 2000),
  attachment_count integer not null default 0 check (attachment_count between 0 and 30),
  attachment_metadata jsonb not null default '[]'::jsonb
    check (jsonb_typeof(attachment_metadata) = 'array'),
  status text not null default 'novo'
    check (status in ('novo', 'em_revisao', 'convertido', 'descartado', 'erro')),
  request_id uuid references public.flow_requests(id) on delete set null,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  discarded_reason text not null default '' check (char_length(discarded_reason) <= 500),
  body_redacted_at timestamptz,
  payload_version smallint not null default 1 check (payload_version between 1 and 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, external_id),
  unique (idempotency_key)
);

create index flow_external_inbox_status_received_idx
  on public.flow_external_inbox (status, received_at desc);
create index flow_external_inbox_request_idx
  on public.flow_external_inbox (request_id)
  where request_id is not null;
create index flow_external_inbox_submitter_idx
  on public.flow_external_inbox (submitted_by_email, received_at desc);

alter table public.flow_external_inbox enable row level security;

create policy flow_external_inbox_staff_select
  on public.flow_external_inbox for select
  to authenticated
  using ((select public.flow_is_staff()));

revoke all on table public.flow_external_inbox from public, anon, authenticated;
grant select on table public.flow_external_inbox to authenticated;
grant select, insert, update on table public.flow_external_inbox to service_role;

comment on table public.flow_external_inbox is
  'Mensagens de Outlook/Teams aguardando revisão humana. Somente a Qualidade pode visualizar e converter.';

-- Apenas o hash do segredo é persistido. O valor original fica no workflow e
-- nunca entra no GitHub nem no banco em texto puro.
create table public.flow_external_webhook_secrets (
  name text primary key,
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  rotated_at timestamptz not null default now()
);

alter table public.flow_external_webhook_secrets enable row level security;
revoke all on table public.flow_external_webhook_secrets from public, anon, authenticated;
grant select, insert, update, delete on table public.flow_external_webhook_secrets to service_role;

-- Descartar é uma decisão auditável da Qualidade. A tabela não aceita UPDATE
-- direto pelo navegador; toda mudança passa por esta função com estado válido.
create or replace function public.flow_discard_external_inbox(
  p_inbox_id uuid,
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  linha public.flow_external_inbox%rowtype;
begin
  if auth.uid() is null or not public.flow_is_staff() then
    raise exception 'Somente a equipe da Qualidade pode descartar entradas externas.'
      using errcode = '42501';
  end if;

  select * into linha
    from public.flow_external_inbox
   where id = p_inbox_id
   for update;
  if not found then
    raise exception 'Entrada externa não encontrada.' using errcode = 'P0002';
  end if;
  if linha.status = 'convertido' then
    raise exception 'A entrada já gerou uma solicitação e não pode ser descartada.'
      using errcode = '23514';
  end if;

  update public.flow_external_inbox
     set status = 'descartado',
         discarded_reason = left(btrim(coalesce(p_reason, '')), 500),
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         updated_at = now()
   where id = p_inbox_id;

  return jsonb_build_object('id', p_inbox_id, 'status', 'descartado');
end;
$$;

revoke all on function public.flow_discard_external_inbox(uuid,text)
  from public, anon;
grant execute on function public.flow_discard_external_inbox(uuid,text)
  to authenticated;

-- A conversão bloqueia a linha, valida novamente o e-mail original e usa o ID
-- da entrada como chave idempotente. Repetir o clique devolve o mesmo protocolo.
create or replace function public.flow_convert_external_inbox(
  p_inbox_id uuid,
  p_type_code text,
  p_requester_name text,
  p_requester_area text,
  p_requester_contact text,
  p_summary text,
  p_description text,
  p_form_data jsonb,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  entrada public.flow_external_inbox%rowtype;
  recibo jsonb;
  contato text := lower(btrim(coalesce(p_requester_contact, '')));
  solicitacao_id uuid;
begin
  if auth.uid() is null or not public.flow_is_staff() then
    raise exception 'Somente a equipe da Qualidade pode converter entradas externas.'
      using errcode = '42501';
  end if;

  select * into entrada
    from public.flow_external_inbox
   where id = p_inbox_id
   for update;
  if not found then
    raise exception 'Entrada externa não encontrada.' using errcode = 'P0002';
  end if;

  if entrada.request_id is not null then
    return public.flow_request_receipt(entrada.request_id);
  end if;
  if entrada.status = 'descartado' then
    raise exception 'Esta entrada foi descartada e não pode ser convertida.'
      using errcode = '23514';
  end if;
  if contato = '' or contato <> entrada.sender_email then
    raise exception 'O contato precisa ser o e-mail original do solicitante: %', entrada.sender_email
      using errcode = '23514';
  end if;

  recibo := public.flow_create_staff_request(
    p_type_code,
    p_requester_name,
    p_requester_area,
    contato,
    p_summary,
    p_description,
    coalesce(p_form_data, '{}'::jsonb) || jsonb_build_object(
      'origem_preenchimento', 'integracao_' || entrada.source,
      'origem_registro', case entrada.source
        when 'outlook' then 'Outlook pela Qualidade'
        else 'Teams pela Qualidade'
      end,
      'canal_origem', entrada.source,
      'external_inbox_id', entrada.id,
      'external_message_id', entrada.external_id,
      '_client_request_id', entrada.id
    ),
    coalesce(p_items, '[]'::jsonb)
  );

  solicitacao_id := nullif(recibo->>'id', '')::uuid;
  if solicitacao_id is null then
    raise exception 'A solicitação foi criada sem recibo identificável.';
  end if;

  update public.flow_external_inbox
     set status = 'convertido',
         request_id = solicitacao_id,
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         updated_at = now()
   where id = entrada.id;

  return recibo;
end;
$$;

revoke all on function public.flow_convert_external_inbox(uuid,text,text,text,text,text,text,jsonb,jsonb)
  from public, anon;
grant execute on function public.flow_convert_external_inbox(uuid,text,text,text,text,text,text,jsonb,jsonb)
  to authenticated;

-- Remove o caminho de favorito do histórico e reconhece as duas integrações.
create or replace function public.flow_create_staff_request(
  p_type_code text,
  p_requester_name text,
  p_requester_area text,
  p_requester_contact text,
  p_summary text,
  p_description text,
  p_form_data jsonb,
  p_items jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  origem text;
  contato text := lower(btrim(coalesce(p_requester_contact, '')));
begin
  if auth.uid() is null then
    raise exception 'É preciso estar autenticado para usar o registro rápido.'
      using errcode = '42501';
  end if;
  if not public.flow_is_staff() then
    raise exception 'Somente a equipe da Qualidade pode usar o registro rápido.'
      using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_requester_name, '')), '') is null then
    raise exception 'Informe o nome do solicitante.' using errcode = '23514';
  end if;
  if contato = '' or contato !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Informe um e-mail válido para o solicitante.' using errcode = '23514';
  end if;
  if nullif(btrim(coalesce(p_summary, '')), '') is null then
    raise exception 'Resuma o que foi solicitado.' using errcode = '23514';
  end if;

  origem := case coalesce(p_form_data, '{}'::jsonb)->>'origem_preenchimento'
    when 'colagem_inteligente' then 'Colagem inteligente pela Qualidade'
    when 'integracao_outlook' then 'Outlook pela Qualidade'
    when 'integracao_teams' then 'Teams pela Qualidade'
    else 'Registro rápido pela Qualidade'
  end;

  return public.flow_create_request(
    p_type_code,
    p_requester_name,
    p_requester_area,
    contato,
    p_summary,
    p_description,
    coalesce(p_form_data, '{}'::jsonb) || jsonb_build_object('origem_registro', origem),
    coalesce(p_items, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.flow_create_staff_request(text,text,text,text,text,text,jsonb,jsonb)
  from public, anon;
grant execute on function public.flow_create_staff_request(text,text,text,text,text,text,jsonb,jsonb)
  to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'flow_external_inbox'
  ) then
    alter publication supabase_realtime add table public.flow_external_inbox;
  end if;
end;
$$;

commit;
