-- GRCON Flow — bootstrap seguro do proprietário e menor privilégio.
-- Antes de aplicar, ou imediatamente depois, cadastre o e-mail do proprietário
-- com flow_prepare_owner_bootstrap() usando service_role/SQL Editor.

create table if not exists public.flow_owner_bootstrap (
  email text primary key check (email=lower(btrim(email))),
  created_at timestamptz not null default now(),
  used_at timestamptz,
  user_id uuid references auth.users(id) on delete set null,
  note text not null default ''
);
alter table public.flow_owner_bootstrap enable row level security;
revoke all on public.flow_owner_bootstrap from public,anon,authenticated;

create or replace function public.flow_prepare_owner_bootstrap(p_email text, p_note text default '')
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare alvo text:=lower(btrim(coalesce(p_email,'')));
begin
  if alvo='' or position('@' in alvo)=0 then raise exception 'Informe um e-mail válido.'; end if;
  if exists(select 1 from public.flow_profiles) then raise exception 'O sistema já possui usuários; gerencie proprietários pela aplicação.'; end if;
  delete from public.flow_owner_bootstrap where used_at is null;
  insert into public.flow_owner_bootstrap(email,note) values(alvo,coalesce(p_note,''))
  on conflict(email) do update set note=excluded.note,created_at=now(),used_at=null,user_id=null;
  return jsonb_build_object('email',alvo,'prepared',true);
end;
$$;
revoke all on function public.flow_prepare_owner_bootstrap(text,text) from public,anon,authenticated;
grant execute on function public.flow_prepare_owner_bootstrap(text,text) to service_role;

create or replace function public.flow_acesso_para(p_email text)
returns table(permitido boolean,papel text,motivo text)
language plpgsql
stable
security definer
set search_path=public
as $$
declare alvo text:=lower(btrim(coalesce(p_email,'')));
        dominio text:=split_part(alvo,'@',2);
        listado record; dominios jsonb;
begin
  if alvo='' or dominio='' then return query select false,null::text,'E-mail inválido.'::text; return; end if;

  if not exists(select 1 from public.flow_profiles) then
    if exists(select 1 from public.flow_owner_bootstrap b where b.email=alvo and b.used_at is null) then
      return query select true,'proprietario'::text,'E-mail preparado para o primeiro proprietário.'::text; return;
    end if;
    return query select false,null::text,
      'O proprietário inicial ainda não foi configurado. Cadastre primeiro o e-mail autorizado no bootstrap seguro.'::text;
    return;
  end if;

  select * into listado from public.flow_access_allowlist where email=alvo;
  if found then return query select true,listado.role,'E-mail autorizado individualmente.'::text; return; end if;

  select value->'dominios' into dominios from public.flow_settings where key='acesso';
  if dominios is null or jsonb_typeof(dominios)<>'array' or jsonb_array_length(dominios)=0 then
    return query select false,null::text,'Nenhum domínio de solicitantes foi autorizado pelo proprietário.'::text; return;
  end if;
  if exists(select 1 from jsonb_array_elements_text(dominios) d where lower(btrim(d))=dominio) then
    return query select true,'solicitante'::text,'Domínio autorizado.'::text; return;
  end if;
  return query select false,null::text,
    ('O cadastro no GRCON Flow é restrito aos e-mails ' ||
      (select string_agg('@'||lower(btrim(d)),', ') from jsonb_array_elements_text(dominios) d) ||
      '. Se você precisa de acesso, peça ao administrador.')::text;
end;
$$;

create or replace function public.flow_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare decisao record; alvo text:=lower(btrim(coalesce(new.email,'')));
begin
  perform pg_advisory_xact_lock(hashtext('flow_owner_bootstrap'));
  select * into decisao from public.flow_acesso_para(alvo);
  if not decisao.permitido then raise exception '%',decisao.motivo using errcode='check_violation'; end if;
  insert into public.flow_profiles(id,email,full_name,area,role)
  values(new.id,alvo,
    coalesce(nullif(btrim(new.raw_user_meta_data->>'full_name'),''),split_part(alvo,'@',1)),
    coalesce(new.raw_user_meta_data->>'area',''),decisao.papel)
  on conflict(id) do nothing;
  if decisao.papel='proprietario' then
    update public.flow_owner_bootstrap set used_at=now(),user_id=new.id where email=alvo and used_at is null;
  end if;
  return new;
end;
$$;

create or replace function public.flow_update_my_profile(p_full_name text,p_area text,p_contact text)
returns void language plpgsql security definer set search_path=public as $$
begin
  if auth.uid() is null then raise exception 'Sessão expirada.'; end if;
  update public.flow_profiles set full_name=btrim(coalesce(p_full_name,'')),area=btrim(coalesce(p_area,'')),
    contact=btrim(coalesce(p_contact,'')),updated_at=now() where id=auth.uid();
  if not found then raise exception 'Perfil não encontrado.'; end if;
end; $$;

create or replace function public.flow_set_user_active(target_user uuid,p_active boolean)
returns void language plpgsql security definer set search_path=public as $$
declare papel text;
begin
  if not public.flow_is_admin() then raise exception 'Somente administradores podem alterar usuários.'; end if;
  select role into papel from public.flow_profiles where id=target_user for update;
  if papel is null then raise exception 'Usuário não encontrado.'; end if;
  if not coalesce(p_active,false) and papel='proprietario'
     and (select count(*) from public.flow_profiles where role='proprietario' and active)<=1 then
    raise exception 'É preciso manter ao menos um proprietário ativo.';
  end if;
  update public.flow_profiles set active=coalesce(p_active,false),updated_at=now() where id=target_user;
end; $$;

drop policy if exists "perfil proprio editavel" on public.flow_profiles;
revoke insert,update,delete on public.flow_profiles from authenticated;
grant select on public.flow_profiles to authenticated;
revoke all on function public.flow_update_my_profile(text,text,text) from public,anon;
revoke all on function public.flow_set_user_active(uuid,boolean) from public,anon;
grant execute on function public.flow_update_my_profile(text,text,text),public.flow_set_user_active(uuid,boolean)
to authenticated,service_role;

-- Solicitações e histórico só mudam pelas funções que validam campos e gravam
-- auditoria. Isso elimina alterações diretas que contornariam as regras.
revoke insert,update,delete on public.flow_requests,public.flow_request_items,public.flow_history from authenticated;
grant select on public.flow_requests,public.flow_request_items,public.flow_history to authenticated;
revoke insert,delete on public.flow_notifications from authenticated;
grant select,update on public.flow_notifications to authenticated;

create or replace function public.flow_notify_new_request()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.flow_notifications(user_id,request_id,kind,title,body)
  select p.id,new.id,'nova_solicitacao','Nova solicitação '||new.protocol,
         new.type_label||' · '||coalesce(nullif(new.requester_name,''),'Solicitante')
  from public.flow_profiles p
  where p.active and p.role in ('operador','administrador','proprietario')
    and (new.requester_id is null or p.id<>new.requester_id);
  return new;
end; $$;
revoke all on function public.flow_notify_new_request() from public,anon,authenticated;

drop trigger if exists flow_notify_new_request_trigger on public.flow_requests;
create trigger flow_notify_new_request_trigger after insert on public.flow_requests
for each row execute function public.flow_notify_new_request();

do $$
begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='flow_notifications') then
    alter publication supabase_realtime add table public.flow_notifications;
  end if;
end $$;

comment on table public.flow_owner_bootstrap is
  'E-mail único autorizado a criar o primeiro proprietário. Nunca exposto ao navegador.';
