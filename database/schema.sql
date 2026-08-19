-- GRCON — Operação de Solicitações independente
-- Schema NOVO. Não é migração nem cópia do banco do GRCON principal.
-- Execute somente em uma NOVA instância/projeto Supabase destinada a este app.

create extension if not exists pgcrypto;

create table if not exists public.sol_workspaces (
  id text primary key,
  name text not null default 'GRCON Solicitações',
  created_at timestamptz not null default now()
);

create table if not exists public.sol_members (
  workspace_id text not null references public.sol_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','operator','viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.sol_request_types (
  workspace_id text not null references public.sol_workspaces(id) on delete cascade,
  code text not null,
  label text not null,
  description text not null default '',
  default_action text not null default '',
  default_priority text not null default 'normal',
  default_deadline_days integer,
  required_fields jsonb not null default '[]'::jsonb,
  active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, code)
);

create table if not exists public.sol_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references public.sol_workspaces(id) on delete cascade,
  request_number text not null,
  received_at date,
  requester text not null default '',
  owner_name text not null default '',
  notes text not null default '',
  status text not null default 'recebido',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, request_number)
);

create table if not exists public.sol_request_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references public.sol_workspaces(id) on delete cascade,
  request_id uuid not null references public.sol_requests(id) on delete cascade,
  item_number integer,
  protocol text not null,
  document text not null default '',
  requested_title text not null default '',
  official_title text not null default '',
  type_code text not null default '',
  owner_name text not null default '',
  status text not null default 'recebido',
  classification text not null default '',
  recommended_action text not null default '',
  reason text not null default '',
  ld_name text not null default '',
  all_lds text not null default '',
  allocation text not null default '',
  allocation_status text not null default '',
  last_grdt text not null default '',
  sigem_status text not null default '',
  revision text not null default '',
  needs_manual_validation boolean not null default false,
  observations text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, protocol)
);

create table if not exists public.sol_request_history (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references public.sol_workspaces(id) on delete cascade,
  protocol text not null,
  action text not null,
  field text not null default '',
  old_value text not null default '',
  new_value text not null default '',
  note text not null default '',
  changed_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create index if not exists sol_request_items_workspace_status_idx on public.sol_request_items(workspace_id, status);
create index if not exists sol_request_items_workspace_owner_idx on public.sol_request_items(workspace_id, owner_name);
create index if not exists sol_request_history_workspace_protocol_idx on public.sol_request_history(workspace_id, protocol, created_at desc);

create or replace function public.sol_member_role(target_workspace text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.sol_members where workspace_id = target_workspace and user_id = auth.uid() limit 1
$$;

create or replace function public.sol_can_write(target_workspace text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.sol_member_role(target_workspace) in ('owner','admin','operator'), false)
$$;

create or replace function public.sol_is_owner(target_workspace text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.sol_member_role(target_workspace) = 'owner', false)
$$;

alter table public.sol_workspaces enable row level security;
alter table public.sol_members enable row level security;
alter table public.sol_request_types enable row level security;
alter table public.sol_requests enable row level security;
alter table public.sol_request_items enable row level security;
alter table public.sol_request_history enable row level security;

create policy "sol workspace members read workspace" on public.sol_workspaces
for select using (exists (select 1 from public.sol_members m where m.workspace_id = id and m.user_id = auth.uid()));

create policy "sol members read own workspace" on public.sol_members
for select using (user_id = auth.uid() or public.sol_is_owner(workspace_id));

create policy "sol types members read" on public.sol_request_types
for select using (public.sol_member_role(workspace_id) is not null);
create policy "sol types owner insert" on public.sol_request_types
for insert with check (public.sol_is_owner(workspace_id));
create policy "sol types owner update" on public.sol_request_types
for update using (public.sol_is_owner(workspace_id)) with check (public.sol_is_owner(workspace_id));
create policy "sol types owner delete" on public.sol_request_types
for delete using (public.sol_is_owner(workspace_id));

create policy "sol requests members read" on public.sol_requests
for select using (public.sol_member_role(workspace_id) is not null);
create policy "sol requests writers insert" on public.sol_requests
for insert with check (public.sol_can_write(workspace_id));
create policy "sol requests writers update" on public.sol_requests
for update using (public.sol_can_write(workspace_id)) with check (public.sol_can_write(workspace_id));

create policy "sol items members read" on public.sol_request_items
for select using (public.sol_member_role(workspace_id) is not null);
create policy "sol items writers insert" on public.sol_request_items
for insert with check (public.sol_can_write(workspace_id));
create policy "sol items writers update" on public.sol_request_items
for update using (public.sol_can_write(workspace_id)) with check (public.sol_can_write(workspace_id));

create policy "sol history members read" on public.sol_request_history
for select using (public.sol_member_role(workspace_id) is not null);
create policy "sol history writers insert" on public.sol_request_history
for insert with check (public.sol_can_write(workspace_id));

create or replace function public.sol_save_request_bundle(
  target_workspace text,
  request_payload jsonb,
  items_payload jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_request_id uuid;
  item jsonb;
begin
  if not public.sol_can_write(target_workspace) then
    raise exception 'Sem permissão para gravar solicitações neste workspace.';
  end if;
  if jsonb_typeof(items_payload) <> 'array' or jsonb_array_length(items_payload) = 0 then
    raise exception 'Nenhum item informado.';
  end if;

  insert into public.sol_requests(workspace_id, request_number, received_at, requester, owner_name, notes, status)
  values (
    target_workspace,
    trim(coalesce(request_payload->>'request_number','')),
    nullif(request_payload->>'received_at','')::date,
    coalesce(request_payload->>'requester',''),
    coalesce(request_payload->>'owner_name',''),
    coalesce(request_payload->>'notes',''),
    coalesce(nullif(request_payload->>'status',''),'recebido')
  ) returning id into new_request_id;

  for item in select * from jsonb_array_elements(items_payload)
  loop
    insert into public.sol_request_items(
      workspace_id, request_id, item_number, protocol, document, requested_title, official_title,
      type_code, owner_name, status, classification, recommended_action, reason, ld_name,
      all_lds, allocation, allocation_status, last_grdt, sigem_status, revision,
      needs_manual_validation, observations
    ) values (
      target_workspace, new_request_id, nullif(item->>'item_number','')::integer,
      coalesce(item->>'protocol',''), coalesce(item->>'document',''), coalesce(item->>'requested_title',''),
      coalesce(item->>'official_title',''), coalesce(item->>'type_code',''), coalesce(item->>'owner_name',''),
      coalesce(nullif(item->>'status',''),'recebido'), coalesce(item->>'classification',''),
      coalesce(item->>'recommended_action',''), coalesce(item->>'reason',''), coalesce(item->>'ld_name',''),
      coalesce(item->>'all_lds',''), coalesce(item->>'allocation',''), coalesce(item->>'allocation_status',''),
      coalesce(item->>'last_grdt',''), coalesce(item->>'sigem_status',''), coalesce(item->>'revision',''),
      coalesce((item->>'needs_manual_validation')::boolean, false), coalesce(item->>'observations','')
    );

    insert into public.sol_request_history(workspace_id, protocol, action)
    values (target_workspace, coalesce(item->>'protocol',''), 'saved');
  end loop;

  return new_request_id;
end;
$$;

create or replace function public.sol_update_request_items(
  target_workspace text,
  target_protocols text[],
  field_name text,
  new_value text,
  note text default ''
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  changed integer := 0;
  row_item record;
  old_value text;
begin
  if not public.sol_can_write(target_workspace) then
    raise exception 'Sem permissão para alterar solicitações neste workspace.';
  end if;
  if field_name not in ('status','owner_name','type_code','observations','classification') then
    raise exception 'Campo não permitido para atualização em lote.';
  end if;

  for row_item in
    select * from public.sol_request_items
    where workspace_id = target_workspace and protocol = any(target_protocols)
    for update
  loop
    old_value := case field_name
      when 'status' then row_item.status
      when 'owner_name' then row_item.owner_name
      when 'type_code' then row_item.type_code
      when 'observations' then row_item.observations
      when 'classification' then row_item.classification
      else '' end;

    if coalesce(old_value,'') = coalesce(new_value,'') then continue; end if;

    if field_name = 'status' then update public.sol_request_items set status = new_value, updated_at = now() where id = row_item.id;
    elsif field_name = 'owner_name' then update public.sol_request_items set owner_name = new_value, updated_at = now() where id = row_item.id;
    elsif field_name = 'type_code' then update public.sol_request_items set type_code = new_value, updated_at = now() where id = row_item.id;
    elsif field_name = 'observations' then update public.sol_request_items set observations = new_value, updated_at = now() where id = row_item.id;
    elsif field_name = 'classification' then update public.sol_request_items set classification = new_value, updated_at = now() where id = row_item.id;
    end if;

    insert into public.sol_request_history(workspace_id, protocol, action, field, old_value, new_value, note)
    values (target_workspace, row_item.protocol, 'updated', field_name, coalesce(old_value,''), coalesce(new_value,''), coalesce(note,''));
    changed := changed + 1;
  end loop;

  return changed;
end;
$$;

-- Inicialização mínima do workspace. Substitua 'default' por outro identificador se desejar.
insert into public.sol_workspaces(id, name) values ('default', 'GRCON Solicitações') on conflict (id) do nothing;

-- Os tipos abaixo são apenas a semente das regras de negócio do módulo novo.
insert into public.sol_request_types(workspace_id, code, label, default_action, default_deadline_days, default_priority, display_order)
values
('default','POSTAGEM_SIGEM','POSTAGEM NO SIGEM','Postar no SIGEM',3,'normal',1),
('default','ALOCACAO','ALOCAÇÃO','Providenciar a alocação',7,'alta',2),
('default','INCLUSAO_LD','INCLUSÃO NA LD','Analisar a inclusão na LD',10,'normal',3),
('default','INCLUSAO_E_ALOCACAO','INCLUIR NA LD E FAZER ALOCAÇÃO','Incluir na LD e providenciar a alocação',10,'alta',4),
('default','IMPRESSAO','IMPRESSÃO','Imprimir conforme solicitado',2,'normal',5),
('default','ALTERACAO_TITULO','ALTERAÇÃO DO TITULO','Conferir o título oficial na LD antes de alterar',5,'normal',6),
('default','CORRECAO_ALOCACAO','CORREÇÃO DE ALOCAÇÃO','Corrigir a alocação registrada',5,'normal',7),
('default','CORRECAO_LD','CORREÇÃO LD','Corrigir o cadastro na LD',5,'normal',8),
('default','INCLUSAO_CV','INCLUSÃO DE CV','Incluir o currículo na LD',5,'normal',9),
('default','POSTAGEM_E_INCLUSAO','POSTAGEM NO SIGEM / INCLUSÃO NA LD','Incluir na LD e postar no SIGEM',7,'normal',10)
on conflict (workspace_id, code) do nothing;
