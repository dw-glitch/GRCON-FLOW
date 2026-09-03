-- Exportada de supabase_migrations.schema_migrations em 03/09/2026.
-- Versão aplicada: 20260819205737.
--
-- Este arquivo é o SQL que de fato criou os objetos no projeto — não uma
-- reconstrução a partir do schema. Ele estava aplicado no banco mas nunca
-- havia sido versionado, o que impedia montar uma instalação nova (ou um
-- ambiente de homologação) a partir do repositório.
--
-- Não edite para corrigir comportamento: uma migração já aplicada é
-- histórico. Mudança de regra entra numa migração nova.

-- GRCON Flow — registro da solicitação e motor de triagem.
--
-- Duas regras mandam neste arquivo:
--   1. A solicitação é registrada SEMPRE. A triagem descreve o que encontrou;
--      não tem poder de recusar o pedido.
--   2. Nada é inventado. Sem código não se deduz código; sem alocação não se
--      preenche alocação. O que falta é dito com todas as letras.

-- A forma nt-neutra do código é calculada pelo motor documental no navegador e
-- viaja junto com o item, para que a busca aqui seja um acesso por índice.
alter table public.flow_request_items
  add column if not exists nt_key text not null default '';
create index if not exists flow_items_nt_key_idx
  on public.flow_request_items(nt_key) where nt_key <> '';

-- Normalização igual à do motor documental: sem acento, caixa alta, espaços
-- colapsados. Escrita com translate() para ser IMMUTABLE e não depender de em
-- qual schema a extensão unaccent foi instalada.
create or replace function public.flow_norm_text(value text)
returns text language sql immutable set search_path = public as $$
  select trim(regexp_replace(
    upper(translate(coalesce(value, ''),
      'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ',
      'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN')),
    '\s+', ' ', 'g'))
$$;

-- ---------------------------------------------------------------------------
-- Registro da solicitação
-- ---------------------------------------------------------------------------
create or replace function public.flow_create_request(
  p_type_code text,
  p_requester_name text,
  p_requester_area text,
  p_requester_contact text,
  p_summary text,
  p_description text,
  p_form_data jsonb,
  p_items jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  tipo record;
  novo_protocolo text;
  nova_solicitacao uuid;
  item jsonb;
  indice integer := 0;
  total integer := 0;
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

  -- Itens. Uma solicitação sem item explícito ainda assim gera um item, para
  -- que pergunta, título ou pedido sem documento tenham onde ser acompanhados.
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

  insert into public.flow_history (request_id, protocol, action, note, actor_id, actor_name)
  values (nova_solicitacao, novo_protocolo, 'solicitacao_registrada',
          tipo.label || ' · ' || total::text || ' item(ns)', auth.uid(), public.flow_current_name());

  perform public.flow_refresh_request_progress(nova_solicitacao);

  return jsonb_build_object(
    'id', nova_solicitacao,
    'protocol', novo_protocolo,
    'items', total,
    'uses_ld', tipo.uses_ld
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Consulta de um documento nas LDs vigentes.
-- Recebe as chaves já normalizadas (código e forma nt-neutra) e devolve todas
-- as ocorrências, sem escolher nenhuma: quem decide é a triagem.
-- ---------------------------------------------------------------------------
create or replace function public.flow_lookup_document(p_keys text[])
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(o) order by o.ld_code, o.sheet, o.row_number), '[]'::jsonb)
  from (
    select
      d.document, d.document_key, d.title, d.revision, d.allocation,
      d.allocation_status, d.allocation_kind, d.grdt, d.sigem_status,
      d.discipline, d.tag, d.sheet, d.row_number, d.ld_version_label,
      l.code as ld_code, l.name as ld_full_name, v.id as ld_version_id,
      v.revision_label as ld_revision
    from public.flow_ld_documents d
    join public.flow_ld_versions v on v.id = d.ld_version_id and v.status = 'ativa'
    join public.flow_lds l on l.id = d.ld_id and l.active
    where (d.document_key = any(p_keys) or (d.nt_key <> '' and d.nt_key = any(p_keys)))
  ) o
$$;

-- Busca por título, para quando o solicitante só sabe o nome do documento.
-- Devolve candidatos ordenados por semelhança — nunca um código escolhido.
create or replace function public.flow_search_by_title(p_query text, p_limit integer default 12)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(c) order by c.score desc), '[]'::jsonb)
  from (
    select distinct on (d.document_key)
      d.document, d.document_key, d.title, d.revision, d.allocation,
      d.allocation_status, d.grdt, d.sigem_status, d.discipline, d.sheet,
      l.code as ld_code,
      similarity(d.title_norm, public.flow_norm_text(p_query)) as score
    from public.flow_ld_documents d
    join public.flow_ld_versions v on v.id = d.ld_version_id and v.status = 'ativa'
    join public.flow_lds l on l.id = d.ld_id and l.active
    where d.title_norm % public.flow_norm_text(p_query)
    order by d.document_key, score desc
    limit greatest(coalesce(p_limit, 12), 1)
  ) c
$$;

-- ---------------------------------------------------------------------------
-- Triagem de um item.
-- ---------------------------------------------------------------------------
create or replace function public.flow_triage_item(target_item uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  it record;
  req record;
  tipo record;
  chaves text[];
  ocorrencias jsonb := '[]'::jsonb;
  candidatos jsonb := '[]'::jsonb;
  qtd integer := 0;
  escolhida jsonb;
  divergente boolean := false;
  classificacao text;
  resumo text := '';
  regra text := '';
  validar boolean := false;
  esperado boolean := false;
  proxima integer;
  versoes jsonb;
begin
  select * into it from public.flow_request_items where id = target_item;
  if not found then raise exception 'Item não encontrado.'; end if;
  select * into req from public.flow_requests where id = it.request_id;
  if not (req.requester_id = auth.uid() or public.flow_is_staff()) then
    raise exception 'Sem permissão para triar este item.';
  end if;
  select * into tipo from public.flow_request_types where id = req.type_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'ld_code', l.code, 'version_id', v.id, 'revision', v.revision_label)), '[]'::jsonb)
    into versoes
    from public.flow_ld_versions v
    join public.flow_lds l on l.id = v.ld_id and l.active
   where v.status = 'ativa';

  -- 1. Tipo que não usa base documental.
  if tipo is null or not tipo.uses_ld then
    classificacao := 'TRIAGEM_NAO_APLICAVEL';
    resumo := 'Este tipo de solicitação não depende de consulta às LDs.';

  -- 2. Sem código informado.
  elsif coalesce(it.document_key, '') = '' then
    if coalesce(tipo.title_search, false) and coalesce(it.requested_title, '') <> '' then
      candidatos := public.flow_search_by_title(it.requested_title, 12);
      if jsonb_array_length(candidatos) > 0 then
        classificacao := 'POSSIVEIS_CORRESPONDENCIAS';
        validar := true;
        resumo := jsonb_array_length(candidatos)::text
               || ' possível(is) correspondência(s) pelo título. Nenhum código foi atribuído automaticamente.';
        regra := 'Busca por semelhança de título nas LDs vigentes. A confirmação do código é do operador.';
      else
        classificacao := 'IDENTIFICACAO_PENDENTE';
        resumo := 'Nenhuma correspondência de título nas LDs vigentes. Código a identificar.';
      end if;
    else
      classificacao := 'IDENTIFICACAO_PENDENTE';
      resumo := 'Solicitação registrada sem código de documento.';
    end if;

  -- 3. Com código: consulta as LDs vigentes.
  else
    chaves := array_remove(array[nullif(it.document_key,''), nullif(it.nt_key,'')], null);
    ocorrencias := public.flow_lookup_document(chaves);
    qtd := jsonb_array_length(ocorrencias);

    if qtd = 0 then
      classificacao := 'NAO_LOCALIZADO';
      esperado := coalesce(tipo.not_found_is_expected, false);
      resumo := 'DOCUMENTO NÃO LOCALIZADO NAS LDS ATIVAS.';
      if esperado then
        resumo := resumo || ' Para este tipo de solicitação isso é esperado.';
      end if;
      regra := 'Pesquisado por: ' || array_to_string(chaves, ' | ');
    else
      -- Divergência entre ocorrências do mesmo documento.
      select count(distinct coalesce(o->>'revision','')) > 1
          or count(distinct coalesce(o->>'title','')) > 1
          or count(distinct coalesce(o->>'allocation','')) > 1
          or count(distinct coalesce(o->>'allocation_kind','')) > 1
        into divergente
        from jsonb_array_elements(ocorrencias) o;

      escolhida := ocorrencias->0;

      if divergente then
        classificacao := 'VALIDAR';
        validar := true;
        resumo := 'Encontrado em ' || qtd::text
               || ' registro(s) com informações divergentes. Escolha qual vale.';
        regra := 'Divergência entre LDs vigentes: nenhuma ocorrência foi eleita automaticamente.';
        escolhida := null;
      elsif coalesce(escolhida->>'allocation','') = ''
            and coalesce(escolhida->>'allocation_kind','') <> 'allocated' then
        classificacao := 'ACAO_NECESSARIA';
        resumo := 'Documento localizado, porém SEM ALOCAÇÃO IDENTIFICADA.';
        regra := 'A LD não registra número de alocação para este documento.';
      else
        classificacao := 'PRONTO';
        resumo := 'Documento localizado na LD ' || coalesce(escolhida->>'ld_code','')
               || ' com alocação ' || coalesce(nullif(escolhida->>'allocation',''), '(confirmada)') || '.';
        regra := case when qtd > 1
                 then 'Localizado em ' || qtd::text || ' registros com a mesma informação.'
                 else 'Ocorrência única nas LDs vigentes.' end;
      end if;
    end if;
  end if;

  -- Retrato no item. Campo não apurado permanece vazio: preencher por
  -- suposição seria pior do que deixar em branco.
  update public.flow_request_items set
    classification = classificacao,
    needs_validation = validar,
    triage_rule = regra,
    occurrence_count = qtd,
    official_title = coalesce(escolhida->>'title',''),
    revision = coalesce(escolhida->>'revision',''),
    allocation = coalesce(escolhida->>'allocation',''),
    allocation_status = coalesce(escolhida->>'allocation_status',''),
    allocation_kind = coalesce(escolhida->>'allocation_kind',''),
    last_grdt = coalesce(escolhida->>'grdt',''),
    sigem_status = coalesce(escolhida->>'sigem_status',''),
    discipline = coalesce(escolhida->>'discipline',''),
    ld_name = coalesce(escolhida->>'ld_code',''),
    ld_version_label = coalesce(escolhida->>'ld_version_label',''),
    all_lds = coalesce((
      select string_agg(distinct o->>'ld_code', ' | ')
      from jsonb_array_elements(ocorrencias) o), ''),
    triaged_at = now(),
    updated_at = now()
  where id = target_item;

  select coalesce(max(run_number), 0) + 1 into proxima
    from public.flow_triage_runs where item_id = target_item;

  insert into public.flow_triage_runs (
    item_id, request_id, run_number, classification, summary, result, ld_versions, created_by
  ) values (
    target_item, it.request_id, proxima, classificacao, resumo,
    jsonb_build_object(
      'occurrences', ocorrencias,
      'candidates', candidatos,
      'chosen', escolhida,
      'divergent', divergente,
      'expected_not_found', esperado,
      'rule', regra,
      'keys', to_jsonb(coalesce(chaves, array[]::text[]))
    ),
    versoes, auth.uid()
  );

  return jsonb_build_object(
    'classification', classificacao,
    'summary', resumo,
    'rule', regra,
    'needs_validation', validar,
    'occurrences', ocorrencias,
    'candidates', candidatos,
    'expected_not_found', esperado,
    'run_number', proxima
  );
end;
$$;

-- Tria a solicitação inteira. Usada logo após o envio e no reprocessamento.
create or replace function public.flow_triage_request(target_request uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  linha record;
  total integer := 0;
  resumo jsonb := '{}'::jsonb;
  classificacao text;
begin
  if not (public.flow_can_see_request(target_request)) then
    raise exception 'Sem permissão para triar esta solicitação.';
  end if;

  for linha in
    select id from public.flow_request_items where request_id = target_request order by item_number
  loop
    classificacao := (public.flow_triage_item(linha.id))->>'classification';
    resumo := jsonb_set(resumo, array[classificacao],
                to_jsonb(coalesce((resumo->>classificacao)::integer, 0) + 1), true);
    total := total + 1;
  end loop;

  update public.flow_requests
     set status = case when status = 'recebido' then 'em_triagem' else status end,
         updated_at = now()
   where id = target_request;

  insert into public.flow_history (request_id, protocol, action, note, actor_id, actor_name)
  select target_request, r.protocol, 'triagem_executada', resumo::text, auth.uid(), public.flow_current_name()
    from public.flow_requests r where r.id = target_request;

  return jsonb_build_object('items', total, 'summary', resumo);
end;
$$;
