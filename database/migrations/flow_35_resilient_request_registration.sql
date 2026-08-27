-- ---------------------------------------------------------------------------
-- flow_35 — registrar primeiro; triar sem colocar o protocolo em risco.
--
-- Antes desta migração, `flow_create_request` criava o pedido, inseria cada
-- item em um loop e ainda executava toda a triagem das LDs na mesma transação.
-- Uma lista grande ultrapassava o `statement_timeout` do Data API e o Postgres
-- desfazia inclusive o protocolo. O solicitante via HTTP 500 mesmo tendo
-- preenchido tudo corretamente.
--
-- A partir daqui:
--   1. o cadastro é curto, set-based e devolve o protocolo antes da triagem;
--   2. uma chave idempotente torna seguro repetir o envio após queda de rede;
--   3. cada item é triado em uma chamada independente pelo navegador;
--   4. o progresso da solicitação é recalculado uma vez no fim da triagem.
-- ---------------------------------------------------------------------------

alter table public.flow_requests
  add column if not exists client_request_id uuid;

create unique index if not exists flow_requests_client_request_uidx
  on public.flow_requests (submitted_by_id, client_request_id)
  where client_request_id is not null;

comment on column public.flow_requests.client_request_id is
  'Chave idempotente gerada pelo navegador. Repetir o mesmo envio devolve o mesmo protocolo.';

-- A criação já chama flow_refresh_request_progress uma vez depois do INSERT
-- em lote. Recalcular depois de cada item fazia o custo crescer quadraticamente.
-- A classificação da triagem também será consolidada apenas ao final.
drop trigger if exists flow_items_progress on public.flow_request_items;
create trigger flow_items_progress
after delete or update of status on public.flow_request_items
for each row execute function public.flow_items_progress_trigger();

create or replace function public.flow_request_receipt(target_request uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', r.id,
    'protocol', r.protocol,
    'items', count(i.id),
    'uses_ld', coalesce(t.uses_ld, false),
    'request_items', coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id,
      'item_number', i.item_number,
      'document', i.document,
      'requires_pdf_excel_pair', i.requires_pdf_excel_pair
    ) order by i.item_number) filter (where i.id is not null), '[]'::jsonb),
    'triage_completed', coalesce(bool_and(i.triaged_at is not null) filter (where i.id is not null), false),
    'triage', null,
    'triage_error', null,
    'on_behalf_of', r.on_behalf_of
  )
  from public.flow_requests r
  left join public.flow_request_types t on t.id = r.type_id
  left join public.flow_request_items i on i.request_id = r.id
  where r.id = target_request
  group by r.id, r.protocol, t.uses_ld, r.on_behalf_of
$$;

revoke all on function public.flow_request_receipt(uuid) from public, anon, authenticated;

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
  total integer := 0;
  ator_nome text := public.flow_current_name();
  ator_email text := '';
  solicitante_nome text;
  solicitante_contato text;
  em_nome_de_outro boolean := false;
  solicitante_id uuid;
  chave_cliente uuid;
begin
  if auth.uid() is null then
    raise exception 'É preciso estar autenticado para registrar uma solicitação.';
  end if;

  begin
    chave_cliente := nullif(coalesce(p_form_data, '{}'::jsonb)->>'_client_request_id', '')::uuid;
  exception when invalid_text_representation then
    raise exception 'Identificador de envio inválido.' using errcode = '22023';
  end;

  -- Uma resposta perdida pela rede não pode criar um segundo protocolo quando
  -- a pessoa tenta de novo. A chave vale somente dentro de quem enviou.
  if chave_cliente is not null then
    select r.id into nova_solicitacao
      from public.flow_requests r
     where r.submitted_by_id = auth.uid()
       and r.client_request_id = chave_cliente;
    if found then
      return public.flow_request_receipt(nova_solicitacao);
    end if;
  end if;

  select coalesce(u.email, '') into ator_email
    from auth.users u where u.id = auth.uid();

  select * into tipo
    from public.flow_request_types
   where code = p_type_code and active;
  if not found then
    raise exception 'Tipo de solicitação desconhecido ou inativo: %', p_type_code;
  end if;

  solicitante_nome := coalesce(nullif(btrim(p_requester_name), ''), ator_nome);
  solicitante_contato := coalesce(btrim(p_requester_contact), '');

  if public.flow_is_staff() then
    em_nome_de_outro :=
      lower(coalesce(solicitante_nome, '')) <> lower(coalesce(ator_nome, ''))
      or (
        solicitante_contato <> ''
        and position('@' in solicitante_contato) > 0
        and lower(solicitante_contato) <> lower(coalesce(ator_email, ''))
      );
  end if;

  solicitante_id := case when em_nome_de_outro then null else auth.uid() end;
  novo_protocolo := public.flow_next_protocol();

  insert into public.flow_requests (
    protocol, type_id, type_code, type_label,
    requester_id, requester_name, requester_area, requester_contact,
    submitted_by_id, submitted_by_name, submitted_by_email, on_behalf_of,
    summary, description, form_data, client_request_id,
    status, priority, due_at
  ) values (
    novo_protocolo, tipo.id, tipo.code, tipo.label,
    solicitante_id, solicitante_nome, coalesce(p_requester_area, ''), solicitante_contato,
    auth.uid(), ator_nome, ator_email, em_nome_de_outro,
    coalesce(p_summary, ''), coalesce(p_description, ''),
    coalesce(p_form_data, '{}'::jsonb) - '_client_request_id', chave_cliente,
    coalesce(nullif(tipo.default_status, ''), 'recebido'), tipo.default_priority,
    (current_date + make_interval(days => greatest(coalesce(tipo.default_deadline_days, 5), 0)))::date
  )
  on conflict (submitted_by_id, client_request_id)
    where client_request_id is not null
  do nothing
  returning id into nova_solicitacao;

  -- Concorrência real: dois cliques iguais podem chegar juntos. O índice deixa
  -- apenas um criar; o outro devolve exatamente o mesmo recibo.
  if nova_solicitacao is null then
    select r.id into nova_solicitacao
      from public.flow_requests r
     where r.submitted_by_id = auth.uid()
       and r.client_request_id = chave_cliente;
    return public.flow_request_receipt(nova_solicitacao);
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    insert into public.flow_request_items (
      request_id, item_number, requested_title, reference, status
    ) values (
      nova_solicitacao, 1, coalesce(p_summary, ''), '', 'recebido'
    );
  else
    -- Uma única instrução substitui o loop e evita o custo de ida e volta por
    -- item dentro do PL/pgSQL. `ordinality` preserva a ordem que a pessoa enviou.
    insert into public.flow_request_items (
      request_id, item_number, document, document_key, nt_key,
      requested_title, reference, file_name, status, due_at
    )
    select
      nova_solicitacao,
      entrada.ordem::integer,
      coalesce(entrada.item->>'document', ''),
      public.flow_norm_text(coalesce(entrada.item->>'document', '')),
      coalesce(entrada.item->>'nt_key', ''),
      coalesce(entrada.item->>'requested_title', ''),
      coalesce(entrada.item->>'reference', ''),
      coalesce(entrada.item->>'file_name', ''),
      'recebido',
      (current_date + make_interval(days => greatest(coalesce(tipo.default_deadline_days, 5), 0)))::date
    from jsonb_array_elements(p_items) with ordinality as entrada(item, ordem);
  end if;

  select count(*) into total
    from public.flow_request_items i where i.request_id = nova_solicitacao;

  insert into public.flow_history (request_id, protocol, action, note, actor_id, actor_name)
  values (
    nova_solicitacao, novo_protocolo, 'solicitacao_registrada',
    tipo.label || ' · ' || total::text || ' item(ns)'
      || case when em_nome_de_outro then ' · registrada em nome de ' || solicitante_nome else '' end,
    auth.uid(), ator_nome
  );

  perform public.flow_refresh_request_progress(nova_solicitacao);

  -- A triagem ficou deliberadamente fora desta transação. O protocolo já está
  -- seguro quando o navegador começa a processar cada item.
  return public.flow_request_receipt(nova_solicitacao);
end;
$$;

revoke all on function public.flow_create_request(text,text,text,text,text,text,jsonb,jsonb)
  from public, anon;
grant execute on function public.flow_create_request(text,text,text,text,text,text,jsonb,jsonb)
  to authenticated;

create or replace function public.flow_complete_request_triage(target_request uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  total integer;
  pendentes integer;
  resumo jsonb;
  ultima_triagem timestamptz;
begin
  if not public.flow_can_see_request(target_request) then
    raise exception 'Sem permissão para concluir a triagem desta solicitação.' using errcode = '42501';
  end if;

  select count(*), count(*) filter (where triaged_at is null), max(triaged_at)
    into total, pendentes, ultima_triagem
    from public.flow_request_items
   where request_id = target_request;

  select coalesce(jsonb_object_agg(i.classification, i.quantidade), '{}'::jsonb)
    into resumo
    from (
      select coalesce(nullif(classification, ''), 'SEM_CLASSIFICACAO') as classification,
             count(*)::integer as quantidade
        from public.flow_request_items
       where request_id = target_request
       group by 1
    ) i;

  if total = 0 then
    raise exception 'A solicitação não possui itens para triar.' using errcode = '23514';
  end if;
  if pendentes > 0 then
    raise exception 'Triagem parcial: % item(ns) ainda pendente(s).', pendentes using errcode = '23514';
  end if;

  perform public.flow_refresh_request_progress(target_request);

  update public.flow_requests
     set status = case when status = 'recebido' then 'em_triagem' else status end,
         updated_at = now()
   where id = target_request;

  -- Se a resposta da finalização se perder e o navegador repetir, não duplica
  -- o histórico enquanto nenhum item tiver sido triado novamente.
  if not exists (
    select 1 from public.flow_history h
     where h.request_id = target_request
       and h.action = 'triagem_executada'
       and h.created_at >= ultima_triagem
  ) then
    insert into public.flow_history (request_id, protocol, action, note, actor_id, actor_name)
    select r.id, r.protocol, 'triagem_executada', resumo::text, auth.uid(), public.flow_current_name()
      from public.flow_requests r where r.id = target_request;
  end if;

  return jsonb_build_object('items', total, 'summary', resumo);
end;
$$;

revoke all on function public.flow_complete_request_triage(uuid) from public, anon;
grant execute on function public.flow_complete_request_triage(uuid) to authenticated;

-- Conferência estrutural sem criar solicitação real.
select
  exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='flow_requests' and column_name='client_request_id'
  ) as idempotencia_disponivel,
  (select pg_get_triggerdef(t.oid) not like '%INSERT%'
     from pg_trigger t
    where t.tgname='flow_items_progress' and not t.tgisinternal) as criacao_sem_recalculo_por_item,
  (select prosrc not like '%flow_triage_request(nova_solicitacao)%'
     from pg_proc where proname='flow_create_request' and pronamespace='public'::regnamespace)
    as cadastro_sem_triagem_sincrona;
