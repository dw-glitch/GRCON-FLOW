-- Exportada de supabase_migrations.schema_migrations em 03/09/2026.
-- Versão aplicada: 20260825123411.
--
-- Este arquivo é o SQL que de fato criou os objetos no projeto — não uma
-- reconstrução a partir do schema. Ele estava aplicado no banco mas nunca
-- havia sido versionado, o que impedia montar uma instalação nova (ou um
-- ambiente de homologação) a partir do repositório.
--
-- Não edite para corrigir comportamento: uma migração já aplicada é
-- histórico. Mudança de regra entra numa migração nova.

update storage.buckets
set allowed_mime_types = array[
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.macroenabled.12',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/acad',
  'application/dwg',
  'application/x-dwg',
  'image/vnd.dwg',
  'application/octet-stream'
]::text[]
where id = 'flow-anexos';

alter table public.flow_attachments
  drop constraint if exists flow_attachments_mime_valid;

alter table public.flow_attachments
  add constraint flow_attachments_mime_valid check (
    case coalesce(lower(substring(file_name, '\.([^.]+)$')), '')
      when 'dwg' then mime_type = any (array[
        'application/acad', 'application/dwg', 'application/x-dwg',
        'image/vnd.dwg', 'application/octet-stream'
      ]::text[])
      when 'pdf' then mime_type = 'application/pdf'
      when 'xls' then mime_type = any (array['application/vnd.ms-excel']::text[])
      when 'xlsx' then mime_type = any (array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']::text[])
      when 'xlsm' then mime_type = any (array[
        'application/vnd.ms-excel.sheet.macroenabled.12',
        'application/vnd.ms-excel.sheet.macroEnabled.12'
      ]::text[])
      when 'doc' then mime_type = 'application/msword'
      when 'docx' then mime_type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      else false
    end
  );

create or replace function public.flow_register_attachment(
  p_request_id uuid,
  p_item_id uuid,
  p_file_name text,
  p_storage_path text,
  p_mime_type text,
  p_size_bytes bigint
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  attachment_id uuid;
  item_row public.flow_request_items%rowtype;
  extension text;
  general_count integer;
  item_is_li_mc boolean := false;
begin
  if actor is null or not public.flow_can_see_request(p_request_id) then
    raise exception 'Sem permissão para anexar arquivos nesta solicitação.' using errcode = '42501';
  end if;

  perform 1 from public.flow_requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'Solicitação não encontrada.' using errcode = 'P0002';
  end if;

  if btrim(coalesce(p_file_name, '')) = '' or char_length(p_file_name) > 255 then
    raise exception 'Nome de arquivo inválido.' using errcode = '23514';
  end if;

  if public.flow_attachment_request_from_path(p_storage_path) is distinct from p_request_id
     or split_part(p_storage_path, '/', 2) = ''
     or split_part(p_storage_path, '/', 3) <> '' then
    raise exception 'Caminho do anexo inválido.' using errcode = '23514';
  end if;

  extension := lower(coalesce(substring(p_file_name from '\.([^.]+)$'), ''));
  if extension not in ('pdf','xls','xlsx','xlsm','doc','docx','dwg') then
    raise exception 'Formato de anexo não permitido. Use PDF, Excel, Word ou DWG.' using errcode = '23514';
  end if;

  if p_item_id is not null then
    select i.* into item_row
      from public.flow_request_items i
     where i.id = p_item_id and i.request_id = p_request_id
     for update;
    if not found then
      raise exception 'O item informado não pertence à solicitação.' using errcode = '23503';
    end if;
    item_is_li_mc := public.flow_is_n1710_li_mc(item_row.document);
  end if;

  if item_is_li_mc then
    if extension not in ('pdf','xls','xlsx','xlsm') then
      raise exception 'LI/MC da N-1710 aceita no conjunto obrigatório somente PDF e Excel.' using errcode = '23514';
    end if;
    if extension = 'pdf' and exists (
      select 1 from public.flow_attachments a
       where a.item_id = p_item_id and lower(a.file_name) ~ '\.pdf$'
    ) then
      raise exception 'Este documento LI/MC já possui o PDF obrigatório.' using errcode = '23505';
    end if;
    if extension in ('xls','xlsx','xlsm') and exists (
      select 1 from public.flow_attachments a
       where a.item_id = p_item_id and lower(a.file_name) ~ '\.(xls|xlsx|xlsm)$'
    ) then
      raise exception 'Este documento LI/MC já possui o Excel obrigatório.' using errcode = '23505';
    end if;
  else
    select count(*) into general_count
      from public.flow_attachments a
      left join public.flow_request_items i on i.id = a.item_id
     where a.request_id = p_request_id
       and not coalesce(i.requires_pdf_excel_pair, false);
    if general_count >= 30 then
      raise exception 'Limite de 30 anexos complementares por solicitação.' using errcode = '23514';
    end if;
  end if;

  insert into public.flow_attachments (
    request_id, item_id, file_name, storage_path, mime_type, size_bytes, uploaded_by
  ) values (
    p_request_id, p_item_id, btrim(p_file_name), p_storage_path,
    coalesce(p_mime_type, ''), p_size_bytes, actor
  ) returning id into attachment_id;

  return attachment_id;
end;
$$;
