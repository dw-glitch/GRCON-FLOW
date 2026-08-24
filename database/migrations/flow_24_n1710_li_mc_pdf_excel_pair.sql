-- GRCON Flow 24 — LI/MC da N-1710 exigem o conjunto PDF + Excel.
--
-- Para Postagem no SIGEM, documentos cuja codificação começa por LI- ou MC-
-- representam documentos N-1710 que chegam sempre em duas representações do
-- mesmo item: um PDF e uma planilha Excel. Os arquivos ficam vinculados ao item
-- da solicitação e o fluxo interno não permite concluir a postagem sem ambos.

begin;

alter table public.flow_request_items
  add column if not exists requires_pdf_excel_pair boolean not null default false,
  add column if not exists pdf_attachment_ready boolean not null default false,
  add column if not exists excel_attachment_ready boolean not null default false;

-- Identificação centralizada da regra para não duplicar regex entre funções.
create or replace function public.flow_is_n1710_li_mc(p_document text)
returns boolean
language sql
immutable
security invoker
set search_path = public
as $$
  select upper(btrim(coalesce(p_document, ''))) ~ '^(LI|MC)-'
$$;

revoke all on function public.flow_is_n1710_li_mc(text) from public, anon;
grant execute on function public.flow_is_n1710_li_mc(text) to authenticated;

-- A nova ação fica entre inclusão na LD e alocação/GRDT: a equipe só segue
-- para a GRDT quando já possui as duas representações que serão usadas.
alter table public.flow_request_items
  drop constraint if exists flow_request_items_next_action_check;
alter table public.flow_request_items
  add constraint flow_request_items_next_action_check
  check (internal_next_action in (
    'IDENTIFICAR_CODIGO','INCLUIR_LD','ANEXAR_PDF_EXCEL','ALOCAR','POSTAR_SIGEM','CONCLUIDO'
  ));

create or replace function public.flow_prepare_item_workflow()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.requires_pdf_excel_pair := public.flow_is_n1710_li_mc(new.document);

  if coalesce(trim(new.document), '') <> '' then
    new.code_stage := 'concluido';
  elsif new.code_stage = 'concluido' then
    new.code_stage := 'pendente';
  end if;

  if coalesce(new.ld_name, '') <> ''
     or coalesce(new.classification, '') in ('PRONTO','ACAO_NECESSARIA','VALIDAR') then
    new.ld_stage := 'concluido';
  end if;

  if coalesce(new.allocation, '') <> '' or coalesce(new.allocation_kind, '') = 'allocated' then
    new.allocation_stage := 'concluido';
  end if;

  if upper(coalesce(new.sigem_status, '')) ~ '(POSTAD|EMITID|CONCLU)' then
    new.sigem_stage := 'concluido';
  end if;

  if new.requires_pdf_excel_pair
     and new.sigem_stage = 'concluido'
     and not (new.pdf_attachment_ready and new.excel_attachment_ready) then
    raise exception 'Para documentos LI/MC da N-1710, anexe o PDF e o Excel antes de concluir a postagem no SIGEM.'
      using errcode = '23514';
  end if;

  new.internal_next_action := case
    when new.sigem_stage = 'concluido' then 'CONCLUIDO'
    when new.code_stage <> 'concluido' then 'IDENTIFICAR_CODIGO'
    when new.ld_stage <> 'concluido' then 'INCLUIR_LD'
    when new.requires_pdf_excel_pair and not (new.pdf_attachment_ready and new.excel_attachment_ready)
      then 'ANEXAR_PDF_EXCEL'
    when new.allocation_stage <> 'concluido' then 'ALOCAR'
    else 'POSTAR_SIGEM'
  end;

  if new.sigem_stage = 'concluido' then
    new.status := 'concluido';
  end if;
  return new;
end;
$$;

revoke all on function public.flow_prepare_item_workflow() from public, anon, authenticated;

drop trigger if exists flow_request_items_prepare_workflow on public.flow_request_items;
create trigger flow_request_items_prepare_workflow
before insert or update of document, classification, ld_name, allocation, allocation_kind, sigem_status,
  code_stage, ld_stage, allocation_stage, sigem_stage,
  requires_pdf_excel_pair, pdf_attachment_ready, excel_attachment_ready
on public.flow_request_items
for each row execute function public.flow_prepare_item_workflow();

-- Recalcula os indicadores de arquivos de um item a partir dos anexos realmente
-- registrados, sem confiar em estado enviado pelo navegador.
create or replace function public.flow_refresh_item_attachment_pair(target_item uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.flow_request_items i
     set pdf_attachment_ready = exists (
           select 1 from public.flow_attachments a
            where a.item_id = i.id and lower(a.file_name) ~ '\.pdf$'
         ),
         excel_attachment_ready = exists (
           select 1 from public.flow_attachments a
            where a.item_id = i.id and lower(a.file_name) ~ '\.(xls|xlsx|xlsm)$'
         ),
         updated_at = now()
   where i.id = target_item;
end;
$$;

revoke all on function public.flow_refresh_item_attachment_pair(uuid) from public, anon, authenticated;

create or replace function public.flow_attachment_pair_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('INSERT','UPDATE') and new.item_id is not null then
    perform public.flow_refresh_item_attachment_pair(new.item_id);
  end if;
  if tg_op in ('DELETE','UPDATE') and old.item_id is not null
     and (tg_op = 'DELETE' or old.item_id is distinct from new.item_id
          or old.file_name is distinct from new.file_name) then
    perform public.flow_refresh_item_attachment_pair(old.item_id);
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public.flow_attachment_pair_trigger() from public, anon, authenticated;

drop trigger if exists flow_attachments_refresh_pair on public.flow_attachments;
create trigger flow_attachments_refresh_pair
after insert or delete or update of item_id, file_name, mime_type
on public.flow_attachments
for each row execute function public.flow_attachment_pair_trigger();

-- O upload físico acontece antes do registro de metadados. Por isso a policy do
-- Storage precisa reservar 2 posições extras para cada LI/MC, além dos 5 anexos
-- complementares já permitidos por solicitação.
create or replace function public.flow_attachment_slots_available(p_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
     and public.flow_can_see_request(p_request_id)
     and (
       select count(*)
         from public.flow_attachments a
        where a.request_id = p_request_id
     ) < 5 + 2 * (
       select count(*)
         from public.flow_request_items i
        where i.request_id = p_request_id
          and public.flow_is_n1710_li_mc(i.document)
     )
$$;

grant execute on function public.flow_attachment_slots_available(uuid) to authenticated;

-- Registro do anexo: 5 complementares continuam sendo o máximo; cada item LI/MC
-- ganha exatamente 1 PDF e 1 Excel vinculados ao próprio item.
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
  item_row record;
  extension text;
  general_count integer;
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

  if p_item_id is not null then
    select i.* into item_row
      from public.flow_request_items i
     where i.id = p_item_id and i.request_id = p_request_id
     for update;
    if not found then
      raise exception 'O item informado não pertence à solicitação.' using errcode = '23503';
    end if;
  end if;

  if p_item_id is not null and public.flow_is_n1710_li_mc(item_row.document) then
    if extension not in ('pdf','xls','xlsx','xlsm') then
      raise exception 'LI/MC da N-1710 aceita neste conjunto somente PDF e Excel.' using errcode = '23514';
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
    if general_count >= 5 then
      raise exception 'Limite de 5 anexos complementares por solicitação.' using errcode = '23514';
    end if;
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

grant execute on function public.flow_register_attachment(uuid,uuid,text,text,text,bigint) to authenticated;

-- O cliente precisa dos IDs dos itens recém-criados para vincular cada par de
-- arquivos ao LI/MC correto durante o upload.
create or replace function public.flow_create_request(
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
security definer
set search_path = public
as $$
declare
  tipo record;
  novo_protocolo text;
  nova_solicitacao uuid;
  item jsonb;
  indice integer := 0;
  total integer := 0;
  itens_criados jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'É preciso estar autenticado para registrar uma solicitação.';
  end if;

  select * into tipo from public.flow_request_types
   where code = p_type_code and active;
  if not found then
    raise exception 'Tipo de solicitação desconhecido ou inativo: %', p_type_code;
  end if;

  novo_protocolo := public.flow_next_protocol();

  insert into public.flow_requests (
    protocol, type_id, type_code, type_label,
    requester_id, requester_name, requester_area, requester_contact,
    summary, description, form_data,
    status, priority, due_at
  ) values (
    novo_protocolo, tipo.id, tipo.code, tipo.label,
    auth.uid(),
    coalesce(nullif(trim(p_requester_name), ''), public.flow_current_name()),
    coalesce(p_requester_area, ''),
    coalesce(p_requester_contact, ''),
    coalesce(p_summary, ''),
    coalesce(p_description, ''),
    coalesce(p_form_data, '{}'::jsonb),
    coalesce(nullif(tipo.default_status, ''), 'recebido'),
    tipo.default_priority,
    (current_date + make_interval(days => greatest(coalesce(tipo.default_deadline_days, 5), 0)))::date
  ) returning id into nova_solicitacao;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    insert into public.flow_request_items (
      request_id, item_number, requested_title, reference, status
    ) values (
      nova_solicitacao, 1, coalesce(p_summary, ''), '', 'recebido'
    );
    total := 1;
  else
    for item in select * from jsonb_array_elements(p_items)
    loop
      indice := indice + 1;
      insert into public.flow_request_items (
        request_id, item_number, document, document_key, nt_key,
        requested_title, reference, file_name, status, due_at
      ) values (
        nova_solicitacao, indice,
        coalesce(item->>'document',''),
        coalesce(item->>'document_key',''),
        coalesce(item->>'nt_key',''),
        coalesce(item->>'requested_title',''),
        coalesce(item->>'reference',''),
        coalesce(item->>'file_name',''),
        'recebido',
        (current_date + make_interval(days => greatest(coalesce(tipo.default_deadline_days, 5), 0)))::date
      );
    end loop;
    total := indice;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', i.id,
           'item_number', i.item_number,
           'document', i.document,
           'requires_pdf_excel_pair', i.requires_pdf_excel_pair
         ) order by i.item_number), '[]'::jsonb)
    into itens_criados
    from public.flow_request_items i
   where i.request_id = nova_solicitacao;

  insert into public.flow_history (request_id, protocol, action, note, actor_id, actor_name)
  values (nova_solicitacao, novo_protocolo, 'solicitacao_registrada',
          tipo.label || ' · ' || total::text || ' item(ns)', auth.uid(), public.flow_current_name());

  perform public.flow_refresh_request_progress(nova_solicitacao);

  return jsonb_build_object(
    'id', nova_solicitacao,
    'protocol', novo_protocolo,
    'items', total,
    'uses_ld', tipo.uses_ld,
    'request_items', itens_criados
  );
end;
$$;

grant execute on function public.flow_create_request(text,text,text,text,text,text,jsonb,jsonb) to authenticated;

-- A equipe também não pode contornar a regra marcando manualmente item ou
-- solicitação como concluído antes de existir o par completo.
create or replace function public.flow_update_items(
  p_item_ids uuid[], p_field text, p_value text, p_note text default ''::text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  linha record;
  anterior text;
  alterados integer := 0;
begin
  if not public.flow_is_staff() then
    raise exception 'Somente a equipe pode alterar itens.';
  end if;
  if p_field not in (
    'status','owner_name','classification','observations','answer','document','requested_title','due_at',
    'code_stage','ld_stage','allocation_stage','sigem_stage'
  ) then
    raise exception 'Campo não permitido para alteração em lote: %', p_field;
  end if;

  for linha in
    select i.*, r.protocol as req_protocol
      from public.flow_request_items i
      join public.flow_requests r on r.id = i.request_id
     where i.id = any(p_item_ids)
     for update of i
  loop
    if ((p_field = 'status' and p_value = 'concluido')
        or (p_field = 'sigem_stage' and p_value = 'concluido'))
       and public.flow_is_n1710_li_mc(linha.document)
       and not (linha.pdf_attachment_ready and linha.excel_attachment_ready) then
      raise exception 'O item % é LI/MC da N-1710. Receba o PDF e o Excel antes de concluir.',
        coalesce(nullif(linha.document,''), linha.item_number::text)
        using errcode = '23514';
    end if;

    anterior := case p_field
      when 'status' then linha.status
      when 'owner_name' then linha.owner_name
      when 'classification' then linha.classification
      when 'observations' then linha.observations
      when 'answer' then linha.answer
      when 'document' then linha.document
      when 'requested_title' then linha.requested_title
      when 'due_at' then coalesce(linha.due_at::text, '')
      when 'code_stage' then linha.code_stage
      when 'ld_stage' then linha.ld_stage
      when 'allocation_stage' then linha.allocation_stage
      when 'sigem_stage' then linha.sigem_stage
      else '' end;

    if coalesce(anterior, '') = coalesce(p_value, '') then continue; end if;

    if p_field = 'status' then
      update public.flow_request_items set status = p_value, updated_at = now() where id = linha.id;
    elsif p_field = 'owner_name' then
      update public.flow_request_items set owner_name = p_value, updated_at = now() where id = linha.id;
    elsif p_field = 'classification' then
      update public.flow_request_items set classification = p_value, updated_at = now() where id = linha.id;
    elsif p_field = 'observations' then
      update public.flow_request_items set observations = p_value, updated_at = now() where id = linha.id;
    elsif p_field = 'answer' then
      update public.flow_request_items set answer = p_value, updated_at = now() where id = linha.id;
    elsif p_field = 'requested_title' then
      update public.flow_request_items set requested_title = p_value, updated_at = now() where id = linha.id;
    elsif p_field = 'document' then
      update public.flow_request_items
         set document = p_value,
             document_key = public.flow_norm_text(p_value),
             updated_at = now()
       where id = linha.id;
    elsif p_field = 'due_at' then
      update public.flow_request_items set due_at = nullif(p_value, '')::date, updated_at = now() where id = linha.id;
    elsif p_field = 'code_stage' then
      update public.flow_request_items set code_stage = p_value, updated_at = now() where id = linha.id;
    elsif p_field = 'ld_stage' then
      update public.flow_request_items set ld_stage = p_value, updated_at = now() where id = linha.id;
    elsif p_field = 'allocation_stage' then
      update public.flow_request_items set allocation_stage = p_value, updated_at = now() where id = linha.id;
    elsif p_field = 'sigem_stage' then
      update public.flow_request_items set sigem_stage = p_value, updated_at = now() where id = linha.id;
    end if;

    insert into public.flow_history (
      request_id, item_id, protocol, action, field, old_value, new_value, note, actor_id, actor_name
    ) values (
      linha.request_id, linha.id, linha.req_protocol, 'item_alterado', p_field,
      coalesce(anterior, ''), coalesce(p_value, ''), coalesce(p_note, ''),
      auth.uid(), public.flow_current_name()
    );
    alterados := alterados + 1;
  end loop;

  return alterados;
end;
$$;

grant execute on function public.flow_update_items(uuid[],text,text,text) to authenticated;

create or replace function public.flow_update_request(
  p_request_id uuid, p_field text, p_value text, p_note text default ''::text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  atual record;
  anterior text;
begin
  if not public.flow_is_staff() then
    raise exception 'Somente a equipe pode alterar solicitações.';
  end if;
  if p_field not in ('status','owner_name','priority','due_at','answer','answer_source','summary') then
    raise exception 'Campo não permitido: %', p_field;
  end if;

  select * into atual from public.flow_requests where id = p_request_id for update;
  if not found then raise exception 'Solicitação não encontrada.'; end if;

  if p_field = 'status' and p_value = 'concluido' and exists (
    select 1
      from public.flow_request_items i
     where i.request_id = p_request_id
       and public.flow_is_n1710_li_mc(i.document)
       and not (i.pdf_attachment_ready and i.excel_attachment_ready)
  ) then
    raise exception 'Há documento LI/MC da N-1710 sem o conjunto PDF + Excel. Complete os arquivos antes de concluir a solicitação.'
      using errcode = '23514';
  end if;

  anterior := case p_field
    when 'status' then atual.status
    when 'owner_name' then atual.owner_name
    when 'priority' then atual.priority
    when 'due_at' then coalesce(atual.due_at::text,'')
    when 'answer' then atual.answer
    when 'answer_source' then atual.answer_source
    when 'summary' then atual.summary
    else '' end;

  if coalesce(anterior,'') = coalesce(p_value,'') then return; end if;

  if p_field = 'status' then
    update public.flow_requests
       set status = p_value,
           closed_at = case when p_value in ('concluido','cancelado') then now() else null end,
           updated_at = now()
     where id = p_request_id;
  elsif p_field = 'owner_name' then
    update public.flow_requests set owner_name = p_value, owner_id = auth.uid(), updated_at = now()
     where id = p_request_id;
  elsif p_field = 'priority' then
    update public.flow_requests set priority = p_value, updated_at = now() where id = p_request_id;
  elsif p_field = 'due_at' then
    update public.flow_requests set due_at = nullif(p_value,'')::date, updated_at = now() where id = p_request_id;
  elsif p_field = 'answer' then
    update public.flow_requests
       set answer = p_value, answered_by = auth.uid(), answered_at = now(), updated_at = now()
     where id = p_request_id;
  elsif p_field = 'answer_source' then
    update public.flow_requests set answer_source = p_value, updated_at = now() where id = p_request_id;
  elsif p_field = 'summary' then
    update public.flow_requests set summary = p_value, updated_at = now() where id = p_request_id;
  end if;

  insert into public.flow_history (
    request_id, protocol, action, field, old_value, new_value, note, actor_id, actor_name
  ) values (
    p_request_id, atual.protocol, 'solicitacao_alterada', p_field,
    coalesce(anterior,''), coalesce(p_value,''), coalesce(p_note,''),
    auth.uid(), public.flow_current_name()
  );

  if p_field = 'status' and atual.requester_id is not null then
    insert into public.flow_notifications (user_id, request_id, kind, title, body)
    values (
      atual.requester_id, p_request_id,
      case when p_value = 'concluido' then 'sucesso' else 'info' end,
      'Solicitação ' || atual.protocol,
      'Status alterado para ' || p_value || '.'
    );
  end if;
end;
$$;

grant execute on function public.flow_update_request(uuid,text,text,text) to authenticated;

-- Backfill: identifica LI/MC já existentes e reconstrói os flags a partir dos
-- anexos vinculados. O trigger do item recalcula a próxima ação automaticamente.
update public.flow_request_items i
   set requires_pdf_excel_pair = public.flow_is_n1710_li_mc(i.document),
       pdf_attachment_ready = exists (
         select 1 from public.flow_attachments a
          where a.item_id = i.id and lower(a.file_name) ~ '\.pdf$'
       ),
       excel_attachment_ready = exists (
         select 1 from public.flow_attachments a
          where a.item_id = i.id and lower(a.file_name) ~ '\.(xls|xlsx|xlsm)$'
       );

update public.flow_request_types
set description = 'Solicite a postagem de um ou vários documentos. Informe o título e, se souber, o código; a equipe cuida das etapas necessárias antes da postagem. Para LI/MC da N-1710, envie obrigatoriamente o conjunto PDF + Excel.',
    panel_columns = '["requested_title","document","internal_next_action","n1710_files","ld_stage","allocation_stage","sigem_stage","classification"]'::jsonb,
    updated_at = now()
where code = 'POSTAGEM_SIGEM';

create or replace view public.flow_export_view
with (security_invoker = true)
as
select
  r.id as request_id,
  i.id as item_id,
  r.protocol,
  i.item_number,
  r.type_code,
  r.type_label,
  r.requester_name,
  r.requester_area,
  r.requester_contact,
  r.created_at as received_at,
  r.summary,
  r.description,
  r.status as request_status,
  r.priority,
  r.due_at as request_due_at,
  r.answer as request_answer,
  r.answer_source,
  coalesce(nullif(i.owner_name, ''), r.owner_name) as owner_name,
  i.document,
  i.requested_title,
  i.reference,
  i.file_name,
  i.official_title,
  i.revision,
  i.allocation,
  i.allocation_status,
  i.last_grdt,
  i.sigem_status,
  i.discipline,
  i.ld_name,
  i.ld_version_label,
  i.all_lds,
  i.classification,
  i.needs_validation,
  i.occurrence_count,
  i.triage_rule,
  i.triaged_at,
  i.status as item_status,
  i.answer as item_answer,
  i.observations,
  i.due_at as item_due_at,
  i.updated_at as item_updated_at,
  i.code_stage,
  i.ld_stage,
  i.allocation_stage,
  i.sigem_stage,
  i.internal_next_action,
  i.requires_pdf_excel_pair,
  i.pdf_attachment_ready,
  i.excel_attachment_ready
from public.flow_requests r
join public.flow_request_items i on i.request_id = r.id;

-- O acompanhamento continua sem expor o fluxo interno, mas permite ao
-- solicitante confirmar que o par obrigatório foi recebido.
create or replace function public.flow_track_protocol(p_protocol text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r record;
  itens jsonb;
begin
  select * into r from public.flow_requests where protocol = upper(trim(p_protocol));
  if not found then return null; end if;
  if not (r.requester_id = auth.uid() or public.flow_is_staff()) then
    raise exception 'Este protocolo não pertence à sua conta.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'item_number', i.item_number,
      'document', i.document,
      'requested_title', i.requested_title,
      'status', i.status,
      'answer', i.answer,
      'requires_pdf_excel_pair', i.requires_pdf_excel_pair,
      'pdf_attachment_ready', i.pdf_attachment_ready,
      'excel_attachment_ready', i.excel_attachment_ready
    ) order by i.item_number), '[]'::jsonb)
    into itens
    from public.flow_request_items i where i.request_id = r.id;

  return jsonb_build_object(
    'protocol', r.protocol,
    'type_label', r.type_label,
    'status', r.status,
    'created_at', r.created_at,
    'due_at', r.due_at,
    'items_total', r.items_total,
    'items_done', r.items_done,
    'answer', r.answer,
    'items', itens
  );
end;
$$;

grant execute on function public.flow_track_protocol(text) to authenticated;

commit;
