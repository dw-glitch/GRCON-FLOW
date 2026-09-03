-- Exportada de supabase_migrations.schema_migrations em 03/09/2026.
-- Versão aplicada: 20260819205307.
--
-- Este arquivo é o SQL que de fato criou os objetos no projeto — não uma
-- reconstrução a partir do schema. Ele estava aplicado no banco mas nunca
-- havia sido versionado, o que impedia montar uma instalação nova (ou um
-- ambiente de homologação) a partir do repositório.
--
-- Não edite para corrigir comportamento: uma migração já aplicada é
-- histórico. Mudança de regra entra numa migração nova.

-- GRCON Flow — tipos de solicitação e seus campos.
-- Os tipos não ficam presos ao código: rótulo, campos, regras, prazo e fluxo
-- são dados, para que a operação mude sem nova publicação do aplicativo.

create table if not exists public.flow_request_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  label text not null,
  description text not null default '',
  icon text not null default 'documento',
  active boolean not null default true,
  display_order integer not null default 0,

  -- Comportamento da triagem
  uses_ld boolean not null default true,          -- consulta as LDs vigentes
  requires_document boolean not null default false, -- exige código do documento
  allows_documents boolean not null default true,   -- aceita lista de documentos
  allows_multiple boolean not null default true,    -- aceita vários itens
  title_search boolean not null default false,      -- procura pelo título quando não há código
  not_found_is_expected boolean not null default false, -- não achar é normal (ex.: Inclusão na LD)

  -- Operação
  default_deadline_days integer not null default 5,
  default_priority text not null default 'normal'
    check (default_priority in ('baixa','normal','alta','urgente')),
  default_status text not null default 'recebido',
  workflow jsonb not null default
    '["recebido","em_triagem","em_execucao","aguardando_validacao","concluido"]'::jsonb,
  -- Colunas que o painel destaca para este tipo.
  panel_columns jsonb not null default
    '["document","official_title","allocation","classification"]'::jsonb,
  answer_required boolean not null default false, -- pedidos de informação exigem resposta

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists flow_request_types_active_idx
  on public.flow_request_types(active, display_order);

-- ---------------------------------------------------------------------------
-- Campos dinâmicos por tipo. O formulário do solicitante é montado a partir
-- daqui — não existe formulário fixo no código.
-- ---------------------------------------------------------------------------
create table if not exists public.flow_type_fields (
  id uuid primary key default gen_random_uuid(),
  type_id uuid not null references public.flow_request_types(id) on delete cascade,
  field_key text not null,
  label text not null,
  help text not null default '',
  placeholder text not null default '',
  field_kind text not null default 'text'
    check (field_kind in ('text','textarea','number','select','date','checkbox','documents','files')),
  options jsonb not null default '[]'::jsonb,
  required boolean not null default false,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (type_id, field_key)
);

create index if not exists flow_type_fields_type_idx
  on public.flow_type_fields(type_id, display_order);

alter table public.flow_request_types enable row level security;
alter table public.flow_type_fields enable row level security;

-- Qualquer usuário autenticado precisa ler os tipos ativos: é o que monta o
-- formulário público. A escrita é de administrador.
create policy "tipos legiveis" on public.flow_request_types
for select using (active or public.flow_is_staff());
create policy "tipos administraveis" on public.flow_request_types
for all using (public.flow_is_admin()) with check (public.flow_is_admin());

create policy "campos legiveis" on public.flow_type_fields
for select using (
  exists (select 1 from public.flow_request_types t
          where t.id = type_id and (t.active or public.flow_is_staff()))
);
create policy "campos administraveis" on public.flow_type_fields
for all using (public.flow_is_admin()) with check (public.flow_is_admin());
