-- Exportada de supabase_migrations.schema_migrations em 03/09/2026.
-- Versão aplicada: 20260819205346.
--
-- Este arquivo é o SQL que de fato criou os objetos no projeto — não uma
-- reconstrução a partir do schema. Ele estava aplicado no banco mas nunca
-- havia sido versionado, o que impedia montar uma instalação nova (ou um
-- ambiente de homologação) a partir do repositório.
--
-- Não edite para corrigir comportamento: uma migração já aplicada é
-- histórico. Mudança de regra entra numa migração nova.

-- GRCON Flow — solicitações, itens, histórico, comentários e anexos.
-- Regra que atravessa este arquivo: a solicitação é registrada sempre. O
-- resultado da triagem descreve o que foi encontrado; nunca impede o registro.

-- Numeração do protocolo. Uma linha por ano, travada na hora de incrementar,
-- para que dois envios simultâneos nunca recebam o mesmo número.
create table if not exists public.flow_protocol_counters (
  year integer primary key,
  last_number integer not null default 0
);

create or replace function public.flow_next_protocol()
returns text language plpgsql security definer set search_path = public as $$
declare
  ano integer := extract(year from now())::integer;
  proximo integer;
begin
  insert into public.flow_protocol_counters (year, last_number)
  values (ano, 1)
  on conflict (year) do update set last_number = public.flow_protocol_counters.last_number + 1
  returning last_number into proximo;
  return 'FLOW-' || ano::text || '-' || lpad(proximo::text, 6, '0');
end;
$$;

-- ---------------------------------------------------------------------------
-- Solicitação
-- ---------------------------------------------------------------------------
create table if not exists public.flow_requests (
  id uuid primary key default gen_random_uuid(),
  protocol text not null unique,

  type_id uuid references public.flow_request_types(id) on delete set null,
  type_code text not null default '',
  type_label text not null default '',

  requester_id uuid references auth.users(id) on delete set null,
  requester_name text not null default '',
  requester_area text not null default '',
  requester_contact text not null default '',

  summary text not null default '',
  description text not null default '',
  -- Respostas dos campos dinâmicos do tipo, na forma {field_key: valor}.
  form_data jsonb not null default '{}'::jsonb,

  status text not null default 'recebido',
  priority text not null default 'normal',
  owner_id uuid references auth.users(id) on delete set null,
  owner_name text not null default '',
  due_at date,

  answer text not null default '',
  answer_source text not null default '',
  answered_by uuid references auth.users(id) on delete set null,
  answered_at timestamptz,

  items_total integer not null default 0,
  items_done integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);

create index if not exists flow_requests_status_idx on public.flow_requests(status, created_at desc);
create index if not exists flow_requests_requester_idx on public.flow_requests(requester_id, created_at desc);
create index if not exists flow_requests_owner_idx on public.flow_requests(owner_id) where owner_id is not null;
create index if not exists flow_requests_type_idx on public.flow_requests(type_code, created_at desc);
create index if not exists flow_requests_due_idx on public.flow_requests(due_at) where closed_at is null;
create index if not exists flow_requests_created_idx on public.flow_requests(created_at desc);

-- ---------------------------------------------------------------------------
-- Item da solicitação
-- Um item pode ser um documento, um título, uma pergunta ou um elemento
-- avulso. Por isso `document` aceita vazio: exigir código aqui inviabilizaria
-- metade dos tipos de pedido.
-- ---------------------------------------------------------------------------
create table if not exists public.flow_request_items (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.flow_requests(id) on delete cascade,
  item_number integer not null default 1,

  document text not null default '',
  document_key text not null default '',
  requested_title text not null default '',
  reference text not null default '',
  file_name text not null default '',

  status text not null default 'recebido',
  classification text not null default '',
  owner_id uuid references auth.users(id) on delete set null,
  owner_name text not null default '',
  due_at date,
  answer text not null default '',
  observations text not null default '',

  -- Retrato da última triagem. O histórico completo fica em flow_triage_runs.
  official_title text not null default '',
  revision text not null default '',
  allocation text not null default '',
  allocation_status text not null default '',
  allocation_kind text not null default '',
  last_grdt text not null default '',
  sigem_status text not null default '',
  discipline text not null default '',
  ld_name text not null default '',
  ld_version_label text not null default '',
  all_lds text not null default '',
  occurrence_count integer not null default 0,
  needs_validation boolean not null default false,
  triage_rule text not null default '',
  triaged_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists flow_items_request_idx on public.flow_request_items(request_id, item_number);
create index if not exists flow_items_status_idx on public.flow_request_items(status);
create index if not exists flow_items_classification_idx on public.flow_request_items(classification);
create index if not exists flow_items_document_key_idx on public.flow_request_items(document_key) where document_key <> '';
create index if not exists flow_items_owner_idx on public.flow_request_items(owner_id) where owner_id is not null;

-- ---------------------------------------------------------------------------
-- Triagens. Reprocessar nunca apaga a análise anterior: cada execução é uma
-- linha nova, com a versão de LD que foi usada.
-- ---------------------------------------------------------------------------
create table if not exists public.flow_triage_runs (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.flow_request_items(id) on delete cascade,
  request_id uuid not null references public.flow_requests(id) on delete cascade,
  run_number integer not null default 1,
  classification text not null default '',
  summary text not null default '',
  result jsonb not null default '{}'::jsonb,
  ld_versions jsonb not null default '[]'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists flow_triage_runs_item_idx
  on public.flow_triage_runs(item_id, run_number desc);

-- ---------------------------------------------------------------------------
-- Histórico, comentários e anexos
-- ---------------------------------------------------------------------------
create table if not exists public.flow_history (
  id uuid primary key default gen_random_uuid(),
  request_id uuid references public.flow_requests(id) on delete cascade,
  item_id uuid references public.flow_request_items(id) on delete cascade,
  protocol text not null default '',
  action text not null,
  field text not null default '',
  old_value text not null default '',
  new_value text not null default '',
  note text not null default '',
  actor_id uuid references auth.users(id) on delete set null,
  actor_name text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists flow_history_request_idx on public.flow_history(request_id, created_at desc);
create index if not exists flow_history_item_idx on public.flow_history(item_id, created_at desc);

create table if not exists public.flow_comments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.flow_requests(id) on delete cascade,
  item_id uuid references public.flow_request_items(id) on delete cascade,
  body text not null,
  -- Comentário interno não é mostrado ao solicitante.
  internal boolean not null default true,
  author_id uuid references auth.users(id) on delete set null,
  author_name text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists flow_comments_request_idx on public.flow_comments(request_id, created_at);

create table if not exists public.flow_attachments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.flow_requests(id) on delete cascade,
  item_id uuid references public.flow_request_items(id) on delete cascade,
  file_name text not null,
  storage_path text not null,
  mime_type text not null default '',
  size_bytes bigint not null default 0,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists flow_attachments_request_idx on public.flow_attachments(request_id);

create table if not exists public.flow_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid references public.flow_requests(id) on delete cascade,
  kind text not null default 'info',
  title text not null,
  body text not null default '',
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists flow_notifications_user_idx
  on public.flow_notifications(user_id, created_at desc) where read_at is null;

create table if not exists public.flow_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

-- ---------------------------------------------------------------------------
-- Progresso da solicitação a partir dos itens.
-- ---------------------------------------------------------------------------
create or replace function public.flow_refresh_request_progress(target_request uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  total integer;
  prontos integer;
begin
  select count(*), count(*) filter (where status in ('concluido','cancelado'))
    into total, prontos
  from public.flow_request_items where request_id = target_request;

  update public.flow_requests
     set items_total = coalesce(total, 0),
         items_done = coalesce(prontos, 0),
         updated_at = now()
   where id = target_request;
end;
$$;

create or replace function public.flow_items_progress_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.flow_refresh_request_progress(coalesce(new.request_id, old.request_id));
  return coalesce(new, old);
end;
$$;

drop trigger if exists flow_items_progress on public.flow_request_items;
create trigger flow_items_progress
after insert or update of status or delete on public.flow_request_items
for each row execute function public.flow_items_progress_trigger();
