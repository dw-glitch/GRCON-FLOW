-- GRCON Flow — proteção de anexos e leitura do consumo do Storage.
--
-- Os objetos continuam privados. O limite de tamanho e a lista de formatos
-- ficam no bucket; quantidade, metadados e autorização são conferidos também
-- no banco. A exclusão física continua sendo feita pelo Storage API — nunca
-- apagamos storage.objects por SQL, para não criar objetos órfãos faturáveis.

update storage.buckets
set public = false,
    file_size_limit = 10485760,
    allowed_mime_types = array[
      'application/pdf',
      'application/vnd.ms-excel',
      'application/vnd.ms-excel.sheet.macroenabled.12',
      'application/vnd.ms-excel.sheet.macroEnabled.12',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]::text[]
where id = 'flow-anexos';

alter table public.flow_attachments
  drop constraint if exists flow_attachments_size_valid,
  drop constraint if exists flow_attachments_extension_valid,
  drop constraint if exists flow_attachments_mime_valid,
  drop constraint if exists flow_attachments_storage_path_key;

alter table public.flow_attachments
  add constraint flow_attachments_size_valid
    check (size_bytes between 1 and 10485760),
  add constraint flow_attachments_extension_valid
    check (coalesce(lower(substring(file_name from '\.([^.]+)$')), '') = any (
      array['pdf','xls','xlsx','xlsm','doc','docx']::text[]
    )),
  add constraint flow_attachments_mime_valid
    check (mime_type = any (array[
      'application/pdf',
      'application/vnd.ms-excel',
      'application/vnd.ms-excel.sheet.macroenabled.12',
      'application/vnd.ms-excel.sheet.macroEnabled.12',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]::text[])),
  add constraint flow_attachments_storage_path_key unique (storage_path);

create or replace function public.flow_attachment_request_from_path(p_path text)
returns uuid
language plpgsql
immutable
strict
set search_path = ''
as $$
begin
  return split_part(p_path, '/', 1)::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

revoke all on function public.flow_attachment_request_from_path(text) from public, anon;
grant execute on function public.flow_attachment_request_from_path(text) to authenticated;

create or replace function public.flow_attachment_slots_available(p_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
     and public.flow_can_see_request(p_request_id)
     and (select count(*) from public.flow_attachments a where a.request_id = p_request_id) < 5
$$;

revoke all on function public.flow_attachment_slots_available(uuid) from public, anon;
grant execute on function public.flow_attachment_slots_available(uuid) to authenticated;

create or replace function public.flow_validate_attachment_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select count(*) from public.flow_attachments a where a.request_id = new.request_id) >= 5 then
    raise exception 'Limite de 5 anexos por solicitação atingido.' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists flow_validate_attachment_limit_trigger on public.flow_attachments;
create trigger flow_validate_attachment_limit_trigger
before insert on public.flow_attachments
for each row execute function public.flow_validate_attachment_limit();

revoke all on function public.flow_validate_attachment_limit() from public, anon, authenticated;

create or replace function public.flow_register_attachment(
  p_request_id uuid,
  p_item_id uuid,
  p_file_name text,
  p_storage_path text,
  p_mime_type text,
  p_size_bytes bigint
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  attachment_id uuid;
begin
  if actor is null or not public.flow_can_see_request(p_request_id) then
    raise exception 'Sem permissão para anexar arquivos nesta solicitação.' using errcode = '42501';
  end if;

  -- Serializa anexos da mesma solicitação para o limite de cinco não sofrer
  -- corrida quando dois uploads terminam quase ao mesmo tempo.
  perform 1 from public.flow_requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'Solicitação não encontrada.' using errcode = 'P0002';
  end if;

  if p_item_id is not null and not exists (
    select 1 from public.flow_request_items i
    where i.id = p_item_id and i.request_id = p_request_id
  ) then
    raise exception 'O item informado não pertence à solicitação.' using errcode = '23503';
  end if;

  if btrim(coalesce(p_file_name, '')) = '' or char_length(p_file_name) > 255 then
    raise exception 'Nome de arquivo inválido.' using errcode = '23514';
  end if;
  if public.flow_attachment_request_from_path(p_storage_path) is distinct from p_request_id
     or split_part(p_storage_path, '/', 2) = ''
     or split_part(p_storage_path, '/', 3) <> '' then
    raise exception 'Caminho do anexo inválido.' using errcode = '23514';
  end if;

  insert into public.flow_attachments (
    request_id, item_id, file_name, storage_path, mime_type, size_bytes, uploaded_by
  ) values (
    p_request_id, p_item_id, btrim(p_file_name), p_storage_path,
    coalesce(p_mime_type, ''), p_size_bytes, actor
  )
  returning id into attachment_id;

  return attachment_id;
end;
$$;

revoke all on function public.flow_register_attachment(uuid,uuid,text,text,text,bigint)
  from public, anon, authenticated;
grant execute on function public.flow_register_attachment(uuid,uuid,text,text,text,bigint)
  to authenticated;

-- Metadados entram somente pelo RPC acima, que valida e serializa o limite.
drop policy if exists "anexos enviados" on public.flow_attachments;
revoke insert, update, delete, truncate, references, trigger
  on public.flow_attachments from anon, authenticated;
grant select on public.flow_attachments to authenticated;

-- O bucket rejeita extensão indevida e o sexto objeto já antes do upload. O
-- RPC repete a verificação depois do upload, fechando também a gravação dos
-- metadados. A policy de remoção permite a limpeza pelo dono ou por admin.
drop policy if exists "flow anexos envio" on storage.objects;
drop policy if exists "flow anexos leitura" on storage.objects;
drop policy if exists "flow anexos remocao" on storage.objects;

create policy "flow anexos envio" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'flow-anexos'
  and public.flow_attachment_request_from_path(name) is not null
  and public.flow_can_see_request(public.flow_attachment_request_from_path(name))
  and public.flow_attachment_slots_available(public.flow_attachment_request_from_path(name))
  and lower(substring(name from '\.([^.]+)$')) = any (
    array['pdf','xls','xlsx','xlsm','doc','docx']::text[]
  )
);

create policy "flow anexos leitura" on storage.objects
for select to authenticated
using (
  bucket_id = 'flow-anexos'
  and public.flow_attachment_request_from_path(name) is not null
  and public.flow_can_see_request(public.flow_attachment_request_from_path(name))
);

create policy "flow anexos remocao" on storage.objects
for delete to authenticated
using (
  bucket_id = 'flow-anexos'
  and ((select auth.uid()) = owner or public.flow_is_admin())
);

create or replace function public.flow_storage_usage()
returns table(
  total_bytes bigint,
  total_files bigint,
  attachment_bytes bigint,
  attachment_files bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.flow_is_staff() then
    raise exception 'Sem permissão para consultar o armazenamento.' using errcode = '42501';
  end if;

  return query
  select
    coalesce(sum(coalesce((o.metadata ->> 'size')::bigint, 0)), 0)::bigint,
    count(*)::bigint,
    coalesce(sum(coalesce((o.metadata ->> 'size')::bigint, 0))
      filter (where o.bucket_id = 'flow-anexos'), 0)::bigint,
    (count(*) filter (where o.bucket_id = 'flow-anexos'))::bigint
  from storage.objects o
  where o.metadata is not null;
end;
$$;

revoke all on function public.flow_storage_usage() from public, anon, authenticated;
grant execute on function public.flow_storage_usage() to authenticated;

comment on function public.flow_register_attachment(uuid,uuid,text,text,text,bigint) is
  'Registra metadados de PDF, Word ou Excel, até 10 MB e cinco arquivos por solicitação.';
comment on function public.flow_storage_usage() is
  'Resumo do consumo de Storage visível somente à equipe do GRCON Flow.';
