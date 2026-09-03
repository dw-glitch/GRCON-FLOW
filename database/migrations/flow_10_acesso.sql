-- Exportada de supabase_migrations.schema_migrations em 03/09/2026.
-- Versão aplicada: 20260820101306.
--
-- Este arquivo é o SQL que de fato criou os objetos no projeto — não uma
-- reconstrução a partir do schema. Ele estava aplicado no banco mas nunca
-- havia sido versionado, o que impedia montar uma instalação nova (ou um
-- ambiente de homologação) a partir do repositório.
--
-- Não edite para corrigir comportamento: uma migração já aplicada é
-- histórico. Mudança de regra entra numa migração nova.

-- GRCON Flow — quem pode entrar, e como.
--
-- Duas audiências, separadas na porta:
--   • quem solicita  — qualquer pessoa de um domínio autorizado da empresa;
--   • equipe         — uma lista de e-mails que o administrador mantém.
--
-- A lista de e-mails passa por cima do domínio: é o que permite dar acesso a
-- alguém de fora sem abrir o domínio inteiro.

-- ---------------------------------------------------------------------------
-- Lista de e-mails autorizados
--
-- `text` normalizado, e não `citext`: a extensão moraria em `extensions`, fora
-- do `search_path = public` que todas as funções deste schema usam, e seus
-- operadores não resolveriam lá dentro.
-- ---------------------------------------------------------------------------
create table if not exists public.flow_access_allowlist (
  email text primary key check (email = lower(btrim(email))),
  role text not null default 'operador'
    check (role in ('solicitante','operador','administrador','proprietario')),
  note text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

alter table public.flow_access_allowlist enable row level security;

create policy "allowlist administravel" on public.flow_access_allowlist
for all using (public.flow_is_admin()) with check (public.flow_is_admin());

-- Procurar perfil por e-mail só é confiável com unicidade; até aqui não havia.
create unique index if not exists flow_profiles_email_uidx
  on public.flow_profiles (lower(email)) where email <> '';

-- Domínios autorizados. Ficam em flow_settings porque o domínio de e-mail de
-- uma empresa não é segredo — já a lista de PESSOAS fica na tabela acima,
-- que é admin-only, porque essa sim revela quem é da equipe.
insert into public.flow_settings (key, value)
values ('acesso', '{"dominios":["agnet.com.br"]}'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- A regra, num lugar só. O hook e o gatilho consultam esta função — se cada um
-- tivesse a sua cópia, um dia elas discordariam.
-- ---------------------------------------------------------------------------
create or replace function public.flow_acesso_para(p_email text)
returns table (permitido boolean, papel text, motivo text)
language plpgsql stable security definer set search_path = public as $$
declare
  alvo text := lower(btrim(coalesce(p_email, '')));
  dominio text := split_part(alvo, '@', 2);
  listado record;
  dominios jsonb;
begin
  if alvo = '' or dominio = '' then
    return query select false, null::text, 'E-mail inválido.'::text;
    return;
  end if;

  -- Enquanto não existe nenhum perfil, o aplicativo ainda não tem dono: o
  -- primeiro cadastro precisa passar para que haja quem administre.
  if not exists (select 1 from public.flow_profiles) then
    return query select true, 'proprietario'::text, 'Primeiro acesso do sistema.'::text;
    return;
  end if;

  select * into listado from public.flow_access_allowlist where email = alvo;
  if found then
    return query select true, listado.role, 'E-mail autorizado individualmente.'::text;
    return;
  end if;

  select value->'dominios' into dominios from public.flow_settings where key = 'acesso';

  -- Sem lista configurada não há restrição: é o estado de um projeto recém
  -- criado, e travar tudo aqui deixaria o dono de fora.
  if dominios is null or jsonb_typeof(dominios) <> 'array' or jsonb_array_length(dominios) = 0 then
    return query select true, 'solicitante'::text, 'Nenhum domínio configurado.'::text;
    return;
  end if;

  if exists (
    select 1 from jsonb_array_elements_text(dominios) d
    where lower(btrim(d)) = dominio
  ) then
    return query select true, 'solicitante'::text, 'Domínio autorizado.'::text;
    return;
  end if;

  return query select false, null::text,
    ('O cadastro no GRCON Flow é restrito aos e-mails '
      || (select string_agg('@' || lower(btrim(d)), ', ')
          from jsonb_array_elements_text(dominios) d)
      || '. Se você precisa de acesso, peça ao administrador.')::text;
end;
$$;

-- Uso interno: só o hook e o gatilho chamam.
revoke all on function public.flow_acesso_para(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Hook "Before User Created".
--
-- Existe por um motivo prático: quando um gatilho de auth.users levanta uma
-- exceção, o GoTrue devolve "Database error saving new user" e engole a
-- mensagem. O hook devolve o texto certo, com 403, e a pessoa entende por que
-- o cadastro não passou.
--
-- Precisa ser ATIVADO no painel do Supabase (Authentication → Hooks). Sem
-- isso, o gatilho abaixo continua barrando — só que com mensagem opaca.
-- ---------------------------------------------------------------------------
create or replace function public.flow_antes_de_criar_usuario(event jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  alvo text := coalesce(event->'user'->>'email', event->>'email', '');
  decisao record;
begin
  select * into decisao from public.flow_acesso_para(alvo);
  if decisao.permitido then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', decisao.motivo
  ));
end;
$$;

revoke all on function public.flow_antes_de_criar_usuario(jsonb) from public, anon, authenticated;
grant execute on function public.flow_antes_de_criar_usuario(jsonb) to supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- Provisionamento do perfil.
--
-- O gatilho continua sendo a trava real (o hook pode não estar ativo) e é quem
-- aplica o papel vindo da lista de autorizados.
-- ---------------------------------------------------------------------------
create or replace function public.flow_handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  decisao record;
begin
  -- Serializa a decisão do primeiro usuário: dois cadastros simultâneos num
  -- sistema vazio poderiam ambos se ver como "o primeiro".
  perform pg_advisory_xact_lock(hashtext('flow_primeiro_usuario'));

  select * into decisao from public.flow_acesso_para(new.email);
  if not decisao.permitido then
    raise exception '%', decisao.motivo using errcode = 'check_violation';
  end if;

  insert into public.flow_profiles (id, email, full_name, area, role)
  values (
    new.id,
    lower(btrim(coalesce(new.email, ''))),
    coalesce(new.raw_user_meta_data->>'full_name', split_part(coalesce(new.email,''), '@', 1)),
    coalesce(new.raw_user_meta_data->>'area', ''),
    decisao.papel
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

revoke all on function public.flow_handle_new_user() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Administração da lista
-- ---------------------------------------------------------------------------
create or replace function public.flow_definir_acesso(
  p_email text,
  p_role text default 'operador',
  p_note text default ''
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  alvo text := lower(btrim(coalesce(p_email, '')));
  usuario uuid;
  promovido boolean := false;
begin
  if not public.flow_is_admin() then
    raise exception 'Somente administradores podem gerenciar o acesso.';
  end if;
  if alvo = '' or position('@' in alvo) = 0 then
    raise exception 'Informe um e-mail válido.';
  end if;
  if p_role not in ('solicitante','operador','administrador','proprietario') then
    raise exception 'Papel inválido: %', p_role;
  end if;
  if p_role = 'proprietario' and not public.flow_is_owner() then
    raise exception 'Somente o proprietário pode conceder o papel de proprietário.';
  end if;

  insert into public.flow_access_allowlist (email, role, note, created_by)
  values (alvo, p_role, coalesce(p_note, ''), auth.uid())
  on conflict (email) do update
    set role = excluded.role, note = excluded.note;

  -- Quem já tem conta é promovido na hora — do contrário a pessoa teria de
  -- apagar e recriar o cadastro para o novo papel valer.
  select id into usuario from auth.users where lower(email) = alvo limit 1;
  if usuario is not null then
    -- Via flow_set_user_role, e não por update direto: é lá que moram as
    -- guardas de quem pode promover quem e a do último proprietário ativo.
    perform public.flow_set_user_role(usuario, p_role);
    promovido := true;
  end if;

  return jsonb_build_object('email', alvo, 'role', p_role, 'promovido_agora', promovido);
end;
$$;

create or replace function public.flow_remover_acesso(p_email text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.flow_is_admin() then
    raise exception 'Somente administradores podem gerenciar o acesso.';
  end if;
  -- Sair da lista impede um cadastro NOVO com aquele papel; não rebaixa quem
  -- já está dentro. Rebaixar é ato explícito, em Usuários.
  delete from public.flow_access_allowlist where email = lower(btrim(coalesce(p_email, '')));
end;
$$;

revoke all on function public.flow_definir_acesso(text,text,text) from public, anon;
grant execute on function public.flow_definir_acesso(text,text,text) to authenticated;
revoke all on function public.flow_remover_acesso(text) from public, anon;
grant execute on function public.flow_remover_acesso(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Domínios autorizados
-- ---------------------------------------------------------------------------
create or replace function public.flow_definir_dominios(p_dominios text[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  limpos text[];
begin
  if not public.flow_is_admin() then
    raise exception 'Somente administradores podem alterar os domínios.';
  end if;

  select coalesce(array_agg(distinct d), array[]::text[]) into limpos
  from (
    select lower(btrim(replace(unnest(coalesce(p_dominios, array[]::text[])), '@', ''))) as d
  ) x
  where d <> '';

  insert into public.flow_settings (key, value, updated_at, updated_by)
  values ('acesso', jsonb_build_object('dominios', to_jsonb(limpos)), now(), auth.uid())
  on conflict (key) do update
    set value = excluded.value, updated_at = now(), updated_by = auth.uid();

  return to_jsonb(limpos);
end;
$$;

revoke all on function public.flow_definir_dominios(text[]) from public, anon;
grant execute on function public.flow_definir_dominios(text[]) to authenticated;
