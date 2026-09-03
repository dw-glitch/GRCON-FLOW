-- Exportada de supabase_migrations.schema_migrations em 03/09/2026.
-- Versão aplicada: 20260819205455.
--
-- Este arquivo é o SQL que de fato criou os objetos no projeto — não uma
-- reconstrução a partir do schema. Ele estava aplicado no banco mas nunca
-- havia sido versionado, o que impedia montar uma instalação nova (ou um
-- ambiente de homologação) a partir do repositório.
--
-- Não edite para corrigir comportamento: uma migração já aplicada é
-- histórico. Mudança de regra entra numa migração nova.

-- GRCON Flow — Base Documental (LDs).
-- As LDs vivem aqui dentro: o solicitante nunca anexa uma. O administrador
-- publica a revisão do dia e todas as triagens seguintes passam a usá-la,
-- sem que a versão anterior seja perdida.

create table if not exists public.flow_lds (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,              -- LD_004, LD_COMISSIONAMENTO, ...
  name text not null default '',
  description text not null default '',
  active boolean not null default true,
  display_order integer not null default 0,
  current_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.flow_ld_versions (
  id uuid primary key default gen_random_uuid(),
  ld_id uuid not null references public.flow_lds(id) on delete cascade,
  revision_label text not null default '',
  file_name text not null default '',
  storage_path text not null default '',
  document_count integer not null default 0,
  sheets jsonb not null default '[]'::jsonb,
  notes text not null default '',
  status text not null default 'processando'
    check (status in ('processando','ativa','inativa','erro')),
  error_message text not null default '',
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_by_name text not null default '',
  created_at timestamptz not null default now(),
  activated_at timestamptz
);

create index if not exists flow_ld_versions_ld_idx
  on public.flow_ld_versions(ld_id, created_at desc);

alter table public.flow_lds
  drop constraint if exists flow_lds_current_version_fk;
alter table public.flow_lds
  add constraint flow_lds_current_version_fk
  foreign key (current_version_id) references public.flow_ld_versions(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Documentos indexados de cada versão.
-- A leitura da planilha continua sendo feita pelo motor documental do GRCON
-- (parseWorkbook); o que chega aqui é o resultado já normalizado, para que a
-- consulta seja uma busca por índice e não uma releitura do arquivo.
-- ---------------------------------------------------------------------------
create table if not exists public.flow_ld_documents (
  id bigserial primary key,
  ld_version_id uuid not null references public.flow_ld_versions(id) on delete cascade,
  ld_id uuid not null references public.flow_lds(id) on delete cascade,

  document text not null default '',
  document_key text not null default '',   -- código normalizado (canonicalId)
  nt_key text not null default '',         -- forma nt-neutra, para documentos ET
  title text not null default '',
  title_norm text not null default '',

  revision text not null default '',
  allocation text not null default '',
  allocation_status text not null default '',
  allocation_kind text not null default '',
  grdt text not null default '',
  sigem_status text not null default '',
  discipline text not null default '',
  document_type text not null default '',
  purpose text not null default '',
  tag text not null default '',
  sheet text not null default '',
  row_number integer not null default 0,
  ld_version_label text not null default '',
  raw jsonb not null default '{}'::jsonb
);

create index if not exists flow_ld_documents_key_idx
  on public.flow_ld_documents(document_key) where document_key <> '';
create index if not exists flow_ld_documents_nt_idx
  on public.flow_ld_documents(nt_key) where nt_key <> '';
create index if not exists flow_ld_documents_version_idx
  on public.flow_ld_documents(ld_version_id);
create index if not exists flow_ld_documents_tag_idx
  on public.flow_ld_documents(tag) where tag <> '';
-- Busca por título é aproximada por natureza; o índice trigram é o que a torna
-- viável sobre dezenas de milhares de linhas.
create index if not exists flow_ld_documents_title_trgm_idx
  on public.flow_ld_documents using gin (title_norm gin_trgm_ops);

alter table public.flow_lds enable row level security;
alter table public.flow_ld_versions enable row level security;
alter table public.flow_ld_documents enable row level security;

-- A Base Documental é área interna: o solicitante nunca a vê.
create policy "lds visiveis a equipe" on public.flow_lds
for select using (public.flow_is_staff());
create policy "lds administraveis" on public.flow_lds
for all using (public.flow_is_admin()) with check (public.flow_is_admin());

create policy "versoes visiveis a equipe" on public.flow_ld_versions
for select using (public.flow_is_staff());
create policy "versoes administraveis" on public.flow_ld_versions
for all using (public.flow_is_admin()) with check (public.flow_is_admin());

create policy "documentos visiveis a equipe" on public.flow_ld_documents
for select using (public.flow_is_staff());
create policy "documentos administraveis" on public.flow_ld_documents
for all using (public.flow_is_admin()) with check (public.flow_is_admin());

-- ---------------------------------------------------------------------------
-- Ingestão em lotes. O navegador lê a planilha e envia os registros já
-- normalizados; cada chamada grava um lote.
-- ---------------------------------------------------------------------------
create or replace function public.flow_ingest_ld_documents(
  target_version uuid,
  docs jsonb
) returns integer language plpgsql security definer set search_path = public as $$
declare
  alvo record;
  gravados integer := 0;
begin
  if not public.flow_is_admin() then
    raise exception 'Somente administradores podem atualizar a Base Documental.';
  end if;
  select v.*, l.id as ld
    into alvo
    from public.flow_ld_versions v
    join public.flow_lds l on l.id = v.ld_id
   where v.id = target_version;
  if not found then
    raise exception 'Versão de LD não encontrada.';
  end if;
  if jsonb_typeof(docs) <> 'array' then
    raise exception 'Lote inválido: esperado um array de documentos.';
  end if;

  insert into public.flow_ld_documents (
    ld_version_id, ld_id, document, document_key, nt_key, title, title_norm,
    revision, allocation, allocation_status, allocation_kind, grdt, sigem_status,
    discipline, document_type, purpose, tag, sheet, row_number, ld_version_label, raw
  )
  select
    target_version, alvo.ld,
    coalesce(d->>'document',''),
    coalesce(d->>'document_key',''),
    coalesce(d->>'nt_key',''),
    coalesce(d->>'title',''),
    coalesce(d->>'title_norm',''),
    coalesce(d->>'revision',''),
    coalesce(d->>'allocation',''),
    coalesce(d->>'allocation_status',''),
    coalesce(d->>'allocation_kind',''),
    coalesce(d->>'grdt',''),
    coalesce(d->>'sigem_status',''),
    coalesce(d->>'discipline',''),
    coalesce(d->>'document_type',''),
    coalesce(d->>'purpose',''),
    coalesce(d->>'tag',''),
    coalesce(d->>'sheet',''),
    coalesce((d->>'row_number')::integer, 0),
    coalesce(d->>'ld_version_label',''),
    coalesce(d->'raw', '{}'::jsonb)
  from jsonb_array_elements(docs) as d
  where coalesce(d->>'document_key','') <> '';

  get diagnostics gravados = row_count;

  update public.flow_ld_versions
     set document_count = document_count + gravados
   where id = target_version;

  return gravados;
end;
$$;

-- ---------------------------------------------------------------------------
-- Ativar a versão recém-enviada. A anterior fica inativa, e não apagada: as
-- triagens antigas precisam continuar dizendo qual base usaram.
-- ---------------------------------------------------------------------------
create or replace function public.flow_activate_ld_version(target_version uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  alvo record;
begin
  if not public.flow_is_admin() then
    raise exception 'Somente administradores podem ativar uma versão de LD.';
  end if;
  select * into alvo from public.flow_ld_versions where id = target_version;
  if not found then raise exception 'Versão de LD não encontrada.'; end if;
  if alvo.document_count = 0 then
    raise exception 'Esta versão não indexou nenhum documento e não pode ser ativada.';
  end if;

  update public.flow_ld_versions
     set status = 'inativa'
   where ld_id = alvo.ld_id and id <> target_version and status = 'ativa';

  update public.flow_ld_versions
     set status = 'ativa', activated_at = now(), error_message = ''
   where id = target_version;

  update public.flow_lds
     set current_version_id = target_version, updated_at = now()
   where id = alvo.ld_id;
end;
$$;

-- Remover uma versão antiga (os documentos saem por cascade).
create or replace function public.flow_delete_ld_version(target_version uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  alvo record;
begin
  if not public.flow_is_admin() then
    raise exception 'Somente administradores podem remover uma versão de LD.';
  end if;
  select * into alvo from public.flow_ld_versions where id = target_version;
  if not found then return; end if;
  if alvo.status = 'ativa' then
    raise exception 'A versão vigente não pode ser removida. Ative outra antes.';
  end if;
  delete from public.flow_ld_versions where id = target_version;
end;
$$;
