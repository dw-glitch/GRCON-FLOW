-- ---------------------------------------------------------------------------
-- flow_32 — imagem passa a ser anexo válido.
--
-- O requisito do cliente diz, com todas as letras, que o sistema guardará
-- "evidências, documentos, imagens, relatórios". A lista de formatos aceitos
-- pelo bucket `flow-anexos` tinha doze tipos MIME — PDF, Office e, desde a
-- flow_27, DWG — e nenhum formato de imagem. Uma foto de campo era recusada na
-- borda do Storage, antes de chegar ao banco.
--
-- São quatro portões para a mesma decisão, e todos precisam concordar, senão o
-- arquivo passa num e falha no seguinte:
--
--   1. `storage.buckets.allowed_mime_types`  — recusa no upload
--   2. `flow_attachments_extension_valid`    — recusa ao gravar metadado
--   3. `flow_attachments_mime_valid`         — idem, por extensão
--   4. `flow_register_attachment`            — a lista dentro do RPC
--
-- Formatos escolhidos: JPEG, PNG e WebP, que todo navegador abre, mais HEIC e
-- HEIF, que é o que o iPhone produz por padrão. O HEIC entra porque recusar a
-- foto de quem está na obra é pior do que guardá-la num formato que a tela
-- ainda não pré-visualiza.
--
-- O que NÃO muda, de propósito:
--
--   • O conjunto obrigatório de LI/MC da N-1710 continua aceitando apenas PDF e
--     Excel. Imagem entra como anexo complementar, nunca como uma das duas
--     representações exigidas pela norma — a regra é do contrato, não nossa.
--   • O teto de 30 anexos complementares por solicitação continua valendo, e
--     imagem conta nele.
--   • O limite de 10 MB por arquivo continua o mesmo. Subi-lo depende da
--     decisão de plano, que é outra conversa; enquanto isso, a tela reduz a
--     foto grande no navegador em vez de recusá-la.
-- ---------------------------------------------------------------------------

update storage.buckets
   set allowed_mime_types = array[
     -- documentos, como já era
     'application/pdf',
     'application/vnd.ms-excel',
     'application/vnd.ms-excel.sheet.macroenabled.12',
     'application/vnd.ms-excel.sheet.macroEnabled.12',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     'application/msword',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/acad',
     'application/x-acad',
     'application/autocad_dwg',
     'image/vnd.dwg',
     'application/octet-stream',
     -- flow_32: evidência fotográfica
     'image/jpeg',
     'image/png',
     'image/webp',
     'image/heic',
     'image/heif'
   ]::text[]
 where id = 'flow-anexos';

-- ---------------------------------------------------------------------------
-- Extensões aceitas ao gravar o metadado.
-- ---------------------------------------------------------------------------
alter table public.flow_attachments
  drop constraint if exists flow_attachments_extension_valid;

alter table public.flow_attachments
  add constraint flow_attachments_extension_valid
    check (coalesce(lower(substring(file_name from '\.([^.]+)$')), '') = any (
      array['pdf','xls','xlsx','xlsm','doc','docx','dwg',
            'jpg','jpeg','png','webp','heic','heif']::text[]
    ));

-- ---------------------------------------------------------------------------
-- MIME conferido por extensão.
--
-- `application/octet-stream` é aceito nas imagens pelo mesmo motivo que já era
-- aceito no DWG: navegador e sistema operacional nem sempre sabem dizer o tipo,
-- e o que decide é a extensão do arquivo, que já foi restrita acima.
-- ---------------------------------------------------------------------------
alter table public.flow_attachments
  drop constraint if exists flow_attachments_mime_valid;

alter table public.flow_attachments
  add constraint flow_attachments_mime_valid check (
    case coalesce(lower(substring(file_name from '\.([^.]+)$')), '')
      when 'dwg' then mime_type = any (array[
        'application/acad', 'application/x-acad', 'application/autocad_dwg',
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
      when 'jpg'  then mime_type = any (array['image/jpeg', 'application/octet-stream']::text[])
      when 'jpeg' then mime_type = any (array['image/jpeg', 'application/octet-stream']::text[])
      when 'png'  then mime_type = any (array['image/png', 'application/octet-stream']::text[])
      when 'webp' then mime_type = any (array['image/webp', 'application/octet-stream']::text[])
      when 'heic' then mime_type = any (array['image/heic', 'image/heif', 'application/octet-stream']::text[])
      when 'heif' then mime_type = any (array['image/heif', 'image/heic', 'application/octet-stream']::text[])
      else false
    end
  );

-- ---------------------------------------------------------------------------
-- O RPC de registro.
--
-- É a função da flow_27 com a lista de extensões ampliada e a mensagem de erro
-- atualizada. Tudo o mais permanece: a checagem de permissão, a validação do
-- caminho, a regra do par PDF+Excel da N-1710 e o teto de 30 complementares.
-- ---------------------------------------------------------------------------
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
  if extension not in ('pdf','xls','xlsx','xlsm','doc','docx','dwg',
                       'jpg','jpeg','png','webp','heic','heif') then
    raise exception 'Formato de anexo não permitido. Use PDF, Excel, Word, DWG ou imagem.' using errcode = '23514';
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

  -- A regra do conjunto obrigatório é do contrato: LI/MC da N-1710 exige PDF e
  -- Excel do mesmo documento. Imagem não substitui nenhum dos dois — quando o
  -- item é LI/MC, ela é recusada aqui, com a mensagem dizendo o porquê.
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

-- ---------------------------------------------------------------------------
-- Conferência: os quatro portões devem concordar depois de aplicar.
-- ---------------------------------------------------------------------------
select
  (select array_length(allowed_mime_types, 1) from storage.buckets where id = 'flow-anexos')
    as formatos_no_bucket,
  (select count(*) from unnest((select allowed_mime_types from storage.buckets where id='flow-anexos')) m
    where m like 'image/%' and m <> 'image/vnd.dwg')                       as formatos_de_imagem,
  (select pg_get_constraintdef(oid) like '%jpg%' from pg_constraint
    where conname = 'flow_attachments_extension_valid')                     as extensao_aceita_imagem,
  (select prosrc like '%''jpg'',''jpeg'',''png'',''webp'',''heic'',''heif''%' from pg_proc
    where proname = 'flow_register_attachment'
      and pronamespace = 'public'::regnamespace)                            as rpc_aceita_imagem;
