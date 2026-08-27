-- GRCON Flow — anexos maiores sem consumo descontrolado e aviso ao responsável.
--
-- O Storage continua separado das tabelas do Postgres. O arquivo individual
-- pode chegar a 50 MiB (teto do plano Free), mas uma solicitação inteira fica
-- limitada a 150 MiB. Assim não recusamos documentos técnicos usuais e, ao
-- mesmo tempo, uma única solicitação não ocupa uma parcela excessiva da cota.

begin;

update storage.buckets
   set public = false,
       file_size_limit = 52428800
 where id = 'flow-anexos';

alter table public.flow_attachments
  drop constraint if exists flow_attachments_size_valid;

alter table public.flow_attachments
  add constraint flow_attachments_size_valid
    check (size_bytes between 1 and 52428800);

-- O RPC mais recente já controla os 30 anexos complementares e os pares
-- obrigatórios PDF + Excel. Este gatilho trata o limite que deve valer para a
-- soma de todos eles e também protege inserções futuras que não passem pelo RPC.
create or replace function public.flow_validate_attachment_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  total_atual bigint;
begin
  select coalesce(sum(a.size_bytes), 0)
    into total_atual
    from public.flow_attachments a
   where a.request_id = new.request_id;

  if total_atual + new.size_bytes > 157286400 then
    raise exception 'Os anexos desta solicitação ultrapassam o limite total de 150 MB.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists flow_validate_attachment_limit_trigger on public.flow_attachments;
create trigger flow_validate_attachment_limit_trigger
before insert on public.flow_attachments
for each row execute function public.flow_validate_attachment_limit();

revoke all on function public.flow_validate_attachment_limit() from public, anon, authenticated;

-- A atribuição passa a gerar um aviso persistente para a pessoa resolvida pela
-- flow_34. Nome livre sem perfil continua registrado, mas não cria a falsa
-- impressão de que alguém foi notificado.
create or replace function public.flow_notify_assigned_responsible()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.owner_profile_id is null
     or new.owner_profile_id is not distinct from old.owner_profile_id then
    return new;
  end if;

  insert into public.flow_notifications (user_id, request_id, kind, title, body)
  values (
    new.owner_profile_id,
    new.id,
    'atividade_atribuida',
    'Nova atividade atribuída · ' || new.protocol,
    concat_ws(' · ', nullif(new.type_label, ''), nullif(new.summary, ''),
      case when new.due_at is not null then 'Prazo ' || to_char(new.due_at, 'DD/MM/YYYY') end)
  );
  return new;
end;
$$;

revoke all on function public.flow_notify_assigned_responsible() from public, anon, authenticated;

drop trigger if exists flow_notify_assigned_responsible_trigger on public.flow_requests;
create trigger flow_notify_assigned_responsible_trigger
after update of owner_profile_id on public.flow_requests
for each row execute function public.flow_notify_assigned_responsible();

comment on function public.flow_notify_assigned_responsible() is
  'Cria aviso persistente para o perfil que acaba de receber a responsabilidade.';

commit;
