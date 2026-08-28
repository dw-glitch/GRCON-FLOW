-- GRCON Flow — Fase 2 do Registro rápido: favoritos pessoais da Qualidade.
--
-- A mensagem colada é analisada somente no navegador e nunca entra nesta
-- tabela. Aqui ficam apenas modelos genéricos pequenos, sem solicitante,
-- contato, códigos ou anexos. Cada pessoa alcança exclusivamente os seus.

create table if not exists public.flow_quick_templates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  type_code text not null references public.flow_request_types(code) on update cascade on delete restrict,
  requester_area text not null default '',
  request_text text not null default '',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint flow_quick_templates_name_length check (char_length(btrim(name)) between 1 and 60),
  constraint flow_quick_templates_area_length check (char_length(requester_area) <= 120),
  constraint flow_quick_templates_text_length check (char_length(request_text) <= 2000),
  constraint flow_quick_templates_sort_order check (sort_order between 0 and 1000)
);

create unique index if not exists flow_quick_templates_owner_name_uidx
  on public.flow_quick_templates (owner_id, lower(btrim(name)));

create index if not exists flow_quick_templates_owner_order_idx
  on public.flow_quick_templates (owner_id, sort_order, created_at);

alter table public.flow_quick_templates enable row level security;

drop policy if exists flow_quick_templates_select_own on public.flow_quick_templates;
create policy flow_quick_templates_select_own
  on public.flow_quick_templates for select
  to authenticated
  using (
    (select auth.uid()) = owner_id
    and (select public.flow_is_staff())
  );

drop policy if exists flow_quick_templates_insert_own on public.flow_quick_templates;
create policy flow_quick_templates_insert_own
  on public.flow_quick_templates for insert
  to authenticated
  with check (
    (select auth.uid()) = owner_id
    and (select public.flow_is_staff())
  );

drop policy if exists flow_quick_templates_update_own on public.flow_quick_templates;
create policy flow_quick_templates_update_own
  on public.flow_quick_templates for update
  to authenticated
  using (
    (select auth.uid()) = owner_id
    and (select public.flow_is_staff())
  )
  with check (
    (select auth.uid()) = owner_id
    and (select public.flow_is_staff())
  );

drop policy if exists flow_quick_templates_delete_own on public.flow_quick_templates;
create policy flow_quick_templates_delete_own
  on public.flow_quick_templates for delete
  to authenticated
  using (
    (select auth.uid()) = owner_id
    and (select public.flow_is_staff())
  );

-- Limite baixo o bastante para não transformar favoritos em arquivo morto,
-- mas amplo para os tipos usados no dia a dia. A função é invoker e enxerga
-- apenas as linhas que a própria RLS já permite ao usuário.
create or replace function public.flow_validate_quick_template()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if auth.uid() is null or not public.flow_is_staff() then
    raise exception 'Somente a equipe da Qualidade pode salvar modelos rápidos.' using errcode = '42501';
  end if;
  if new.owner_id is distinct from auth.uid() then
    raise exception 'O modelo precisa pertencer ao usuário autenticado.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.owner_id is distinct from old.owner_id then
    raise exception 'Não é possível transferir um modelo para outra pessoa.' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and (
    select count(*) from public.flow_quick_templates t where t.owner_id = auth.uid()
  ) >= 20 then
    raise exception 'Você pode manter até 20 favoritos.' using errcode = '23514';
  end if;
  new.name := btrim(new.name);
  new.requester_area := btrim(coalesce(new.requester_area, ''));
  new.request_text := btrim(coalesce(new.request_text, ''));
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.flow_validate_quick_template() from public, anon, authenticated;

drop trigger if exists flow_quick_templates_validate on public.flow_quick_templates;
create trigger flow_quick_templates_validate
before insert or update on public.flow_quick_templates
for each row execute function public.flow_validate_quick_template();

revoke all on table public.flow_quick_templates from public, anon, authenticated;
grant select, insert, update, delete on table public.flow_quick_templates to authenticated;

comment on table public.flow_quick_templates is
  'Favoritos pessoais do Registro rápido. RLS limita cada linha ao dono e à equipe da Qualidade.';

-- A mesma porta protegida da Fase 1 passa a registrar qual caminho de
-- preenchimento foi usado. O navegador não escolhe texto arbitrário para o
-- histórico: o banco traduz uma lista fechada de valores.
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

  if nullif(btrim(coalesce(p_summary, '')), '') is null then
    raise exception 'Resuma o que foi solicitado.' using errcode = '23514';
  end if;

  origem := case coalesce(p_form_data, '{}'::jsonb)->>'origem_preenchimento'
    when 'colagem_inteligente' then 'Colagem inteligente pela Qualidade'
    when 'modelo_favorito' then 'Modelo favorito pela Qualidade'
    else 'Registro rápido pela Qualidade'
  end;

  return public.flow_create_request(
    p_type_code,
    p_requester_name,
    p_requester_area,
    p_requester_contact,
    p_summary,
    p_description,
    coalesce(p_form_data, '{}'::jsonb)
      || jsonb_build_object('origem_registro', origem),
    coalesce(p_items, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.flow_create_staff_request(text,text,text,text,text,text,jsonb,jsonb)
  from public, anon;
grant execute on function public.flow_create_staff_request(text,text,text,text,text,text,jsonb,jsonb)
  to authenticated;
