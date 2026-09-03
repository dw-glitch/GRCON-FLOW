-- Exportada de supabase_migrations.schema_migrations em 03/09/2026.
-- Versão aplicada: 20260819205246.
--
-- Este arquivo é o SQL que de fato criou os objetos no projeto — não uma
-- reconstrução a partir do schema. Ele estava aplicado no banco mas nunca
-- havia sido versionado, o que impedia montar uma instalação nova (ou um
-- ambiente de homologação) a partir do repositório.
--
-- Não edite para corrigir comportamento: uma migração já aplicada é
-- histórico. Mudança de regra entra numa migração nova.

-- GRCON Flow — base de identidade e permissões.
-- Banco exclusivo do GRCON Flow. Nada aqui vem do GRCON principal.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create extension if not exists unaccent;

-- ---------------------------------------------------------------------------
-- Perfis
-- Quatro papéis, do menor para o maior alcance:
--   solicitante  — cria e acompanha o que é dele
--   operador     — executa as solicitações
--   administrador— gerencia a operação, tipos, LDs e responsáveis
--   proprietario — controle total, inclusive usuários e configurações
-- ---------------------------------------------------------------------------
create table if not exists public.flow_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '',
  full_name text not null default '',
  area text not null default '',
  contact text not null default '',
  role text not null default 'solicitante'
    check (role in ('solicitante','operador','administrador','proprietario')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists flow_profiles_role_idx on public.flow_profiles(role) where active;

-- O papel é lido por uma função SECURITY DEFINER: dentro de uma policy, um
-- select direto em flow_profiles reentraria na própria policy da tabela.
create or replace function public.flow_current_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.flow_profiles where id = auth.uid() and active limit 1
$$;

create or replace function public.flow_is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.flow_current_role() in ('operador','administrador','proprietario'), false)
$$;

create or replace function public.flow_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.flow_current_role() in ('administrador','proprietario'), false)
$$;

create or replace function public.flow_is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.flow_current_role() = 'proprietario', false)
$$;

-- Nome de exibição do usuário atual, usado no histórico e nos comentários.
create or replace function public.flow_current_name()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif(full_name,''), email, 'usuário')
  from public.flow_profiles where id = auth.uid() limit 1
$$;

-- ---------------------------------------------------------------------------
-- Todo usuário do Auth ganha perfil automaticamente.
-- O primeiro a entrar vira proprietário: sem isso não haveria como administrar
-- o aplicativo recém-publicado. Os demais entram como solicitantes.
-- ---------------------------------------------------------------------------
create or replace function public.flow_handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  primeiro boolean;
begin
  select not exists (select 1 from public.flow_profiles) into primeiro;
  insert into public.flow_profiles (id, email, full_name, area, role)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'full_name', split_part(coalesce(new.email,''), '@', 1)),
    coalesce(new.raw_user_meta_data->>'area', ''),
    case when primeiro then 'proprietario' else 'solicitante' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists flow_on_auth_user_created on auth.users;
create trigger flow_on_auth_user_created
after insert on auth.users
for each row execute function public.flow_handle_new_user();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.flow_profiles enable row level security;

create policy "perfil proprio visivel" on public.flow_profiles
for select using (id = auth.uid() or public.flow_is_staff());

create policy "perfil proprio editavel" on public.flow_profiles
for update using (id = auth.uid() or public.flow_is_admin())
with check (id = auth.uid() or public.flow_is_admin());

-- Somente o proprietário cria ou remove perfis manualmente; o restante chega
-- pelo gatilho do Auth.
create policy "proprietario gerencia perfis" on public.flow_profiles
for insert with check (public.flow_is_owner());

create policy "proprietario remove perfis" on public.flow_profiles
for delete using (public.flow_is_owner());

-- Trocar o papel de alguém é privilégio de administrador; a função existe para
-- que a regra não dependa de uma policy de UPDATE genérica.
create or replace function public.flow_set_user_role(target_user uuid, new_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.flow_is_admin() then
    raise exception 'Somente administradores podem alterar papéis.';
  end if;
  if new_role not in ('solicitante','operador','administrador','proprietario') then
    raise exception 'Papel inválido: %', new_role;
  end if;
  -- Só o proprietário cria outro proprietário.
  if new_role = 'proprietario' and not public.flow_is_owner() then
    raise exception 'Somente o proprietário pode promover outro proprietário.';
  end if;
  -- Nunca deixar a aplicação sem nenhum proprietário ativo.
  if new_role <> 'proprietario'
     and (select role from public.flow_profiles where id = target_user) = 'proprietario'
     and (select count(*) from public.flow_profiles where role = 'proprietario' and active) <= 1 then
    raise exception 'É preciso manter ao menos um proprietário ativo.';
  end if;
  update public.flow_profiles set role = new_role, updated_at = now() where id = target_user;
end;
$$;
