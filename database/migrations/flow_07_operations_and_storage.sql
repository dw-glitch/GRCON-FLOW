-- Exportada de supabase_migrations.schema_migrations em 03/09/2026.
-- Versão aplicada: 20260819205828.
--
-- Este arquivo é o SQL que de fato criou os objetos no projeto — não uma
-- reconstrução a partir do schema. Ele estava aplicado no banco mas nunca
-- havia sido versionado, o que impedia montar uma instalação nova (ou um
-- ambiente de homologação) a partir do repositório.
--
-- Não edite para corrigir comportamento: uma migração já aplicada é
-- histórico. Mudança de regra entra numa migração nova.

-- GRCON Flow — operações do painel, exportação e Storage.

-- ---------------------------------------------------------------------------
-- Alteração em lote de itens, com histórico de cada mudança.
-- ---------------------------------------------------------------------------
create or replace function public.flow_update_items(
  p_item_ids uuid[],
  p_field text,
  p_value text,
  p_note text default ''
) returns integer language plpgsql security definer set search_path = public as $$
declare
  linha record;
  anterior text;
  alterados integer := 0;
  protocolo text;
begin
  if not public.flow_is_staff() then
    raise exception 'Somente a equipe pode alterar itens.';
  end if;
  if p_field not in ('status','owner_name','classification','observations','answer','document','due_at') then
    raise exception 'Campo não permitido para alteração em lote: %', p_field;
  end if;

  for linha in
    select i.*, r.protocol as req_protocol
      from public.flow_request_items i
      join public.flow_requests r on r.id = i.request_id
     where i.id = any(p_item_ids)
     for update of i
  loop
    anterior := case p_field
      when 'status' then linha.status
      when 'owner_name' then linha.owner_name
      when 'classification' then linha.classification
      when 'observations' then linha.observations
      when 'answer' then linha.answer
      when 'document' then linha.document
      when 'due_at' then coalesce(linha.due_at::text, '')
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
    elsif p_field = 'document' then
      -- Confirmar o código de um item que chegou só com título. A triagem
      -- seguinte passa a valer para o código confirmado.
      update public.flow_request_items
         set document = p_value,
             document_key = public.flow_norm_text(p_value),
             updated_at = now()
       where id = linha.id;
    elsif p_field = 'due_at' then
      update public.flow_request_items
         set due_at = nullif(p_value, '')::date, updated_at = now() where id = linha.id;
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

-- ---------------------------------------------------------------------------
-- Alteração da solicitação (status, responsável, prazo, prioridade, resposta).
-- ---------------------------------------------------------------------------
create or replace function public.flow_update_request(
  p_request_id uuid,
  p_field text,
  p_value text,
  p_note text default ''
) returns void language plpgsql security definer set search_path = public as $$
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

  -- O solicitante é avisado do que muda para ele.
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

-- ---------------------------------------------------------------------------
-- Consulta de acompanhamento por protocolo.
-- Devolve apenas o que o solicitante pode ver: nada de dado interno.
-- ---------------------------------------------------------------------------
create or replace function public.flow_track_protocol(p_protocol text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
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
      'answer', i.answer
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

-- ---------------------------------------------------------------------------
-- Visão de exportação: uma linha por item, com o que o Controle de
-- Solicitações precisa. A formatação das 26 colunas fica no aplicativo.
-- ---------------------------------------------------------------------------
create or replace view public.flow_export_view
with (security_invoker = true) as
select
  r.id                as request_id,
  i.id                as item_id,
  r.protocol,
  i.item_number,
  r.type_code,
  r.type_label,
  r.requester_name,
  r.requester_area,
  r.requester_contact,
  r.created_at        as received_at,
  r.summary,
  r.description,
  r.status            as request_status,
  r.priority,
  r.due_at            as request_due_at,
  r.answer            as request_answer,
  r.answer_source,
  coalesce(nullif(i.owner_name,''), r.owner_name) as owner_name,
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
  i.status            as item_status,
  i.answer            as item_answer,
  i.observations,
  i.due_at            as item_due_at,
  i.updated_at        as item_updated_at
from public.flow_requests r
join public.flow_request_items i on i.request_id = r.id;

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'flow-anexos', 'flow-anexos', false, 26214400,
  array['application/pdf','image/png','image/jpeg','image/gif','image/webp',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/msword','text/plain','text/csv','message/rfc822',
        'application/vnd.ms-outlook','application/zip']
) on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'flow-lds', 'flow-lds', false, 104857600,
  array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel','application/vnd.ms-excel.sheet.macroenabled.12']
) on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Anexos: quem participa da solicitação envia e lê. O caminho começa pelo id
-- da solicitação, e é isso que a policy confere.
drop policy if exists "flow anexos leitura" on storage.objects;
create policy "flow anexos leitura" on storage.objects
for select using (
  bucket_id = 'flow-anexos'
  and public.flow_can_see_request(nullif(split_part(name, '/', 1), '')::uuid)
);

drop policy if exists "flow anexos envio" on storage.objects;
create policy "flow anexos envio" on storage.objects
for insert with check (
  bucket_id = 'flow-anexos'
  and auth.uid() is not null
  and public.flow_can_see_request(nullif(split_part(name, '/', 1), '')::uuid)
);

drop policy if exists "flow anexos remocao" on storage.objects;
create policy "flow anexos remocao" on storage.objects
for delete using (bucket_id = 'flow-anexos' and (owner = auth.uid() or public.flow_is_admin()));

-- Arquivos de LD: área interna, administrada.
drop policy if exists "flow lds leitura" on storage.objects;
create policy "flow lds leitura" on storage.objects
for select using (bucket_id = 'flow-lds' and public.flow_is_staff());

drop policy if exists "flow lds escrita" on storage.objects;
create policy "flow lds escrita" on storage.objects
for insert with check (bucket_id = 'flow-lds' and public.flow_is_admin());

drop policy if exists "flow lds remocao" on storage.objects;
create policy "flow lds remocao" on storage.objects
for delete using (bucket_id = 'flow-lds' and public.flow_is_admin());
