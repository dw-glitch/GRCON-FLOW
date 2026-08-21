-- GRCON Flow 21 — fluxo único de Postagem no SIGEM.
-- O solicitante pede somente "Postagem no SIGEM". A equipe controla, por item,
-- identificação de código -> inclusão na LD -> alocação -> postagem no SIGEM.

alter table public.flow_request_items
  add column if not exists code_stage text not null default 'pendente',
  add column if not exists ld_stage text not null default 'pendente',
  add column if not exists allocation_stage text not null default 'pendente',
  add column if not exists sigem_stage text not null default 'pendente',
  add column if not exists internal_next_action text not null default 'IDENTIFICAR_CODIGO';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'flow_request_items_code_stage_check') then
    alter table public.flow_request_items add constraint flow_request_items_code_stage_check
      check (code_stage in ('pendente','em_andamento','concluido','nao_aplicavel'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'flow_request_items_ld_stage_check') then
    alter table public.flow_request_items add constraint flow_request_items_ld_stage_check
      check (ld_stage in ('pendente','em_andamento','concluido','nao_aplicavel'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'flow_request_items_allocation_stage_check') then
    alter table public.flow_request_items add constraint flow_request_items_allocation_stage_check
      check (allocation_stage in ('pendente','em_andamento','concluido','nao_aplicavel'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'flow_request_items_sigem_stage_check') then
    alter table public.flow_request_items add constraint flow_request_items_sigem_stage_check
      check (sigem_stage in ('pendente','em_andamento','concluido','nao_aplicavel'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'flow_request_items_next_action_check') then
    alter table public.flow_request_items add constraint flow_request_items_next_action_check
      check (internal_next_action in ('IDENTIFICAR_CODIGO','INCLUIR_LD','ALOCAR','POSTAR_SIGEM','CONCLUIDO'));
  end if;
end $$;

create or replace function public.flow_prepare_item_workflow()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
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

  new.internal_next_action := case
    when new.sigem_stage = 'concluido' then 'CONCLUIDO'
    when new.code_stage <> 'concluido' then 'IDENTIFICAR_CODIGO'
    when new.ld_stage <> 'concluido' then 'INCLUIR_LD'
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
  code_stage, ld_stage, allocation_stage, sigem_stage
on public.flow_request_items
for each row execute function public.flow_prepare_item_workflow();

-- Reclassifica o acervo existente sem apagar informação operacional manual.
update public.flow_request_items
set code_stage = case when coalesce(trim(document), '') <> '' then 'concluido' else code_stage end,
    ld_stage = case when coalesce(ld_name, '') <> '' or classification in ('PRONTO','ACAO_NECESSARIA','VALIDAR') then 'concluido' else ld_stage end,
    allocation_stage = case when coalesce(allocation, '') <> '' or allocation_kind = 'allocated' then 'concluido' else allocation_stage end,
    sigem_stage = case when upper(coalesce(sigem_status, '')) ~ '(POSTAD|EMITID|CONCLU)' then 'concluido' else sigem_stage end;

-- O solicitante deixa de escolher etapas internas como serviços separados.
update public.flow_request_types
set active = false, updated_at = now()
where code in ('ALOCACAO','INCLUSAO_LD','INCLUSAO_E_ALOCACAO');

update public.flow_request_types
set label = 'Postagem no SIGEM',
    description = 'Solicite a postagem de um ou vários documentos. Informe o título e, se souber, o código; a equipe cuida das etapas necessárias antes da postagem.',
    active = true,
    uses_ld = true,
    requires_document = false,
    allows_documents = true,
    allows_multiple = true,
    title_search = true,
    panel_columns = '["requested_title","document","internal_next_action","ld_stage","allocation_stage","sigem_stage","classification"]'::jsonb,
    updated_at = now()
where code = 'POSTAGEM_SIGEM';

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
  i.internal_next_action
from public.flow_requests r
join public.flow_request_items i on i.request_id = r.id;
