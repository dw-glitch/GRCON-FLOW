-- GRCON Flow 25 — triagem LD prioritária, solicitação em nome de terceiros e anexos ampliados.
-- 2026-08-24
--
-- Objetivos:
-- 1) a primeira resposta de cada item documental passa a ser NOVO x JÁ EXISTE NAS LDs;
-- 2) quando já existe, preservar e exibir a alocação/LD encontrada;
-- 3) reconhecer códigos contidos em nomes de arquivos com revisão/sufixos;
-- 4) executar a triagem no servidor já na criação da solicitação;
-- 5) permitir que a equipe registre em nome de pessoa sem cadastro, mantendo auditoria;
-- 6) elevar anexos complementares de 5 para 30 e aceitar DWG.

begin;

-- ---------------------------------------------------------------------------
-- Auditoria de quem registrou x quem é o solicitante informado.
-- ---------------------------------------------------------------------------
alter table public.flow_requests
  add column if not exists submitted_by_id uuid,
  add column if not exists submitted_by_name text not null default '',
  add column if not exists submitted_by_email text not null default '',
  add column if not exists on_behalf_of boolean not null default false;

update public.flow_requests r
   set submitted_by_id = coalesce(r.submitted_by_id, r.requester_id),
       submitted_by_name = case when r.submitted_by_name = '' then r.requester_name else r.submitted_by_name end
 where r.submitted_by_id is null or r.submitted_by_name = '';

-- ---------------------------------------------------------------------------
-- Resultado objetivo da primeira etapa de triagem documental.
-- ---------------------------------------------------------------------------
alter table public.flow_request_items
  add column if not exists ld_presence_status text not null default 'NAO_AVALIADO',
  add column if not exists is_new_document boolean;

alter table public.flow_request_items
  drop constraint if exists flow_request_items_ld_presence_status_check;
alter table public.flow_request_items
  add constraint flow_request_items_ld_presence_status_check
  check (ld_presence_status in (
    'NAO_AVALIADO',
    'NOVO',
    'JA_EXISTE',
    'JA_EXISTE_DIVERGENTE',
    'PENDENTE_IDENTIFICACAO',
    'POSSIVEL_EXISTENTE',
    'NAO_APLICAVEL'
  ));

-- ---------------------------------------------------------------------------
-- Busca flexível nas LDs atuais.
-- Usa exclusivamente current_version_id de cada LD ativa e aceita um código
-- seguido por revisão, extensão, título ou outros sufixos de nome de arquivo.
-- ---------------------------------------------------------------------------
create or replace function public.flow_lookup_document_flexible(
  p_document text,
  p_keys text[] default array[]::text[]
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with parametros as (
    select
      public.flow_norm_text(coalesce(p_document, '')) as raw_key,
      public.flow_norm_text(
        regexp_replace(
          coalesce(p_document, ''),
          '\.(pdf|dwg|xls|xlsx|xlsm|doc|docx)$',
          '',
          'i'
        )
      ) as clean_key,
      coalesce(p_keys, array[]::text[]) as supplied_keys
  ), ocorrencias as (
    select
      d.document, d.document_key, d.title, d.revision, d.allocation,
      d.allocation_status, d.allocation_kind, d.grdt, d.sigem_status,
      d.discipline, d.tag, d.sheet, d.row_number, d.ld_version_label,
      l.code as ld_code, l.name as ld_full_name, v.id as ld_version_id,
      v.revision_label as ld_revision,
      case
        when d.document_key = any(p.supplied_keys)
          or (d.nt_key <> '' and d.nt_key = any(p.supplied_keys)) then 3
        when p.clean_key = d.document_key
          or (d.nt_key <> '' and p.clean_key = d.nt_key) then 3
        when length(d.document_key) >= 12
          and left(p.clean_key, length(d.document_key)) = d.document_key
          and substring(p.clean_key from length(d.document_key) + 1 for 1) in ('', '_', ' ', '-', '.', '(', '[') then 2
        when d.nt_key <> '' and length(d.nt_key) >= 12
          and left(p.clean_key, length(d.nt_key)) = d.nt_key
          and substring(p.clean_key from length(d.nt_key) + 1 for 1) in ('', '_', ' ', '-', '.', '(', '[') then 2
        else 0
      end as match_quality
    from parametros p
    cross join public.flow_ld_documents d
    join public.flow_lds l
      on l.id = d.ld_id
     and l.active
    join public.flow_ld_versions v
      on v.id = l.current_version_id
     and v.id = d.ld_version_id
     and v.status = 'ativa'
    where
      d.document_key = any(p.supplied_keys)
      or (d.nt_key <> '' and d.nt_key = any(p.supplied_keys))
      or p.clean_key = d.document_key
      or (d.nt_key <> '' and p.clean_key = d.nt_key)
      or (
        length(d.document_key) >= 12
        and left(p.clean_key, length(d.document_key)) = d.document_key
        and substring(p.clean_key from length(d.document_key) + 1 for 1) in ('', '_', ' ', '-', '.', '(', '[')
      )
      or (
        d.nt_key <> ''
        and length(d.nt_key) >= 12
        and left(p.clean_key, length(d.nt_key)) = d.nt_key
        and substring(p.clean_key from length(d.nt_key) + 1 for 1) in ('', '_', ' ', '-', '.', '(', '[')
      )
  )
  select coalesce(
    jsonb_agg(to_jsonb(o) - 'match_quality' order by o.match_quality desc, o.ld_code, o.sheet, o.row_number),
    '[]'::jsonb
  )
  from ocorrencias o
  where o.match_quality > 0
$$;

revoke all on function public.flow_lookup_document_flexible(text,text[]) from public, anon;
grant execute on function public.flow_lookup_document_flexible(text,text[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Triagem: primeiro NOVO x JÁ EXISTE; depois alocação e demais dados.
-- ---------------------------------------------------------------------------
create or replace function public.flow_triage_item(target_item uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  it record;
  req record;
  tipo record;
  chaves text[];
  chave_servidor text;
  ocorrencias jsonb := '[]'::jsonb;
  candidatos jsonb := '[]'::jsonb;
  qtd integer := 0;
  escolhida jsonb;
  divergente boolean := false;
  qtd_alocacoes integer := 0;
  alocacao_unica text := '';
  classificacao text;
  presenca text := 'NAO_AVALIADO';
  novo boolean := null;
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

  -- auth.uid() nulo é reservado a execução administrativa/migração. Chamadas
  -- autenticadas continuam submetidas à mesma regra de visibilidade.
  if auth.uid() is not null
     and not (req.requester_id = auth.uid() or req.submitted_by_id = auth.uid() or public.flow_is_staff()) then
    raise exception 'Sem permissão para triar este item.';
  end if;

  select * into tipo from public.flow_request_types where id = req.type_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'ld_code', l.code, 'version_id', v.id, 'revision', v.revision_label)
           order by l.display_order), '[]'::jsonb)
    into versoes
    from public.flow_lds l
    join public.flow_ld_versions v on v.id = l.current_version_id
   where l.active and v.status = 'ativa';

  if tipo is null or not tipo.uses_ld then
    classificacao := 'TRIAGEM_NAO_APLICAVEL';
    presenca := 'NAO_APLICAVEL';
    novo := null;
    resumo := 'Triagem em LD não se aplica a este tipo de solicitação.';

  elsif coalesce(trim(it.document), '') = '' then
    if coalesce(tipo.title_search, false) and coalesce(trim(it.requested_title), '') <> '' then
      candidatos := public.flow_search_by_title(it.requested_title, 12);
      if jsonb_array_length(candidatos) > 0 then
        classificacao := 'POSSIVEIS_CORRESPONDENCIAS';
        presenca := 'POSSIVEL_EXISTENTE';
        novo := null;
        validar := true;
        resumo := jsonb_array_length(candidatos)::text
               || ' possível(is) correspondência(s) nas LDs. Confirme o código antes de decidir se é novo.';
        regra := 'Busca por título nas versões atuais das LDs; o código não é atribuído automaticamente.';
      else
        classificacao := 'IDENTIFICACAO_PENDENTE';
        presenca := 'PENDENTE_IDENTIFICACAO';
        novo := null;
        resumo := 'Código ainda não informado. É necessário identificar o documento antes de classificar como novo ou existente.';
        regra := 'Nenhuma correspondência segura pelo título nas LDs atuais.';
      end if;
    else
      classificacao := 'IDENTIFICACAO_PENDENTE';
      presenca := 'PENDENTE_IDENTIFICACAO';
      novo := null;
      resumo := 'Código ainda não informado. Identificar o documento é a primeira ação.';
    end if;

  else
    chave_servidor := public.flow_norm_text(it.document);
    chaves := array_remove(array[
      nullif(chave_servidor, ''),
      nullif(it.document_key, ''),
      nullif(it.nt_key, '')
    ], null);

    ocorrencias := public.flow_lookup_document_flexible(it.document, chaves);
    qtd := jsonb_array_length(ocorrencias);

    if qtd = 0 then
      classificacao := 'NAO_LOCALIZADO';
      presenca := 'NOVO';
      novo := true;
      esperado := coalesce(tipo.not_found_is_expected, false);
      resumo := 'NOVO — o código não consta em nenhuma das LDs ativas.';
      regra := 'Busca feita nas versões atuais das LDs por código exato e por código-base dentro do nome do arquivo. Pesquisado: '
               || array_to_string(chaves, ' | ');
    else
      presenca := 'JA_EXISTE';
      novo := false;

      select count(distinct coalesce(o->>'revision','')) > 1
          or count(distinct coalesce(o->>'title','')) > 1
          or count(distinct coalesce(o->>'allocation','')) > 1
          or count(distinct coalesce(o->>'allocation_kind','')) > 1
        into divergente
        from jsonb_array_elements(ocorrencias) o;

      -- Mesmo havendo divergência de título/revisão, uma única alocação não
      -- deve ser escondida do operador.
      select count(distinct nullif(o->>'allocation','')),
             coalesce(max(nullif(o->>'allocation','')), '')
        into qtd_alocacoes, alocacao_unica
        from jsonb_array_elements(ocorrencias) o;

      escolhida := ocorrencias->0;

      if divergente then
        classificacao := 'VALIDAR';
        presenca := 'JA_EXISTE_DIVERGENTE';
        validar := true;
        resumo := 'JÁ EXISTE NAS LDs — encontrado em ' || qtd::text
               || ' registro(s), com divergência de informações.';
        regra := case
          when qtd_alocacoes = 1 then 'Há divergências, porém a alocação encontrada é única e foi preservada.'
          when qtd_alocacoes > 1 then 'Foram encontradas alocações diferentes; validar qual registro é o vigente.'
          else 'Há divergências de título/revisão entre as LDs; validar o registro vigente.'
        end;
      elsif coalesce(escolhida->>'allocation','') = ''
            and coalesce(escolhida->>'allocation_kind','') <> 'allocated' then
        classificacao := 'ACAO_NECESSARIA';
        resumo := 'JÁ EXISTE NAS LDs — documento localizado, mas ainda sem alocação identificada.';
        regra := 'O documento existe na base vigente, porém a LD não informa alocação/GRDT para ele.';
      else
        classificacao := 'PRONTO';
        resumo := 'JÁ EXISTE NAS LDs — localizado na ' || coalesce(escolhida->>'ld_code','')
               || ' com alocação ' || coalesce(nullif(escolhida->>'allocation',''), '(confirmada)') || '.';
        regra := case when qtd > 1
                 then 'Encontrado em ' || qtd::text || ' registros equivalentes nas LDs vigentes.'
                 else 'Ocorrência única na versão vigente da LD.' end;
      end if;
    end if;
  end if;

  update public.flow_request_items set
    document_key = case when coalesce(trim(it.document), '') <> '' then public.flow_norm_text(it.document) else document_key end,
    classification = classificacao,
    ld_presence_status = presenca,
    is_new_document = novo,
    needs_validation = validar,
    triage_rule = regra,
    occurrence_count = qtd,
    official_title = coalesce(escolhida->>'title',''),
    revision = coalesce(escolhida->>'revision',''),
    allocation = case
      when divergente and qtd_alocacoes = 1 then alocacao_unica
      else coalesce(escolhida->>'allocation','')
    end,
    allocation_status = coalesce(escolhida->>'allocation_status',''),
    allocation_kind = coalesce(escolhida->>'allocation_kind',''),
    last_grdt = coalesce(escolhida->>'grdt',''),
    sigem_status = coalesce(escolhida->>'sigem_status',''),
    discipline = coalesce(escolhida->>'discipline',''),
    ld_name = coalesce(escolhida->>'ld_code',''),
    ld_version_label = coalesce(escolhida->>'ld_version_label',''),
    all_lds = coalesce((
      select string_agg(distinct o->>'ld_code', ' | ' order by o->>'ld_code')
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
      'ld_presence_status', presenca,
      'is_new_document', novo,
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
    'ld_presence_status', presenca,
    'is_new_document', novo,
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

grant execute on function public.flow_triage_item(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Criação de solicitação: identidade informada separada do usuário que lançou
-- o pedido, e triagem feita no mesmo fluxo do servidor.
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
  ator_nome text := public.flow_current_name();
  ator_email text := '';
  solicitante_nome text;
  solicitante_contato text;
  em_nome_de_outro boolean := false;
  solicitante_id uuid;
  triagem_resultado jsonb := null;
  triagem_ok boolean := false;
  triagem_erro text := '';
  documento_bruto text;
begin
  if auth.uid() is null then
    raise exception 'É preciso estar autenticado para registrar uma solicitação.';
  end if;

  select coalesce(u.email, '') into ator_email from auth.users u where u.id = auth.uid();

  select * into tipo from public.flow_request_types
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
    summary, description, form_data,
    status, priority, due_at
  ) values (
    novo_protocolo, tipo.id, tipo.code, tipo.label,
    solicitante_id,
    solicitante_nome,
    coalesce(p_requester_area, ''),
    solicitante_contato,
    auth.uid(), ator_nome, ator_email, em_nome_de_outro,
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
      documento_bruto := coalesce(item->>'document','');
      insert into public.flow_request_items (
        request_id, item_number, document, document_key, nt_key,
        requested_title, reference, file_name, status, due_at
      ) values (
        nova_solicitacao, indice,
        documento_bruto,
        public.flow_norm_text(documento_bruto),
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
  values (
    nova_solicitacao, novo_protocolo, 'solicitacao_registrada',
    tipo.label || ' · ' || total::text || ' item(ns)'
      || case when em_nome_de_outro then ' · registrada em nome de ' || solicitante_nome else '' end,
    auth.uid(), ator_nome
  );

  perform public.flow_refresh_request_progress(nova_solicitacao);

  -- A solicitação nunca é perdida por uma falha de triagem, mas a triagem é
  -- tentada no servidor antes de devolver o protocolo.
  if tipo.uses_ld then
    begin
      triagem_resultado := public.flow_triage_request(nova_solicitacao);
      triagem_ok := true;
    exception when others then
      triagem_erro := sqlerrm;
      insert into public.flow_history (request_id, protocol, action, note, actor_id, actor_name)
      values (nova_solicitacao, novo_protocolo, 'triagem_falhou', triagem_erro, auth.uid(), ator_nome);
    end;
  end if;

  return jsonb_build_object(
    'id', nova_solicitacao,
    'protocol', novo_protocolo,
    'items', total,
    'uses_ld', tipo.uses_ld,
    'request_items', itens_criados,
    'triage_completed', triagem_ok,
    'triage', triagem_resultado,
    'triage_error', nullif(triagem_erro, ''),
    'on_behalf_of', em_nome_de_outro
  );
end;
$$;

grant execute on function public.flow_create_request(text,text,text,text,text,text,jsonb,jsonb) to authenticated;

-- A pessoa que lançou em nome de terceiro continua tendo visibilidade se for a
-- própria responsável pelo lançamento; a equipe mantém acesso global.
create or replace function public.flow_can_see_request(target_request uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.flow_requests r
    where r.id = target_request
      and (
        r.requester_id = auth.uid()
        or r.submitted_by_id = auth.uid()
        or public.flow_is_staff()
      )
  )
$$;

grant execute on function public.flow_can_see_request(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 30 anexos complementares + DWG. LI/MC mantém o par obrigatório PDF + Excel.
-- ---------------------------------------------------------------------------
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
       select count(*) from public.flow_attachments a where a.request_id = p_request_id
     ) < 30 + 2 * (
       select count(*) from public.flow_request_items i
        where i.request_id = p_request_id and public.flow_is_n1710_li_mc(i.document)
     )
$$;

grant execute on function public.flow_attachment_slots_available(uuid) to authenticated;

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
  end if;

  if p_item_id is not null and public.flow_is_n1710_li_mc(item_row.document) then
    if extension not in ('pdf','xls','xlsx','xlsm') then
      raise exception 'LI/MC da N-1710 aceita no conjunto obrigatório somente PDF e Excel.' using errcode = '23514';
    end if;
    if extension = 'pdf' and exists (
      select 1 from public.flow_attachments a where a.item_id = p_item_id and lower(a.file_name) ~ '\.pdf$'
    ) then
      raise exception 'Este documento LI/MC já possui o PDF obrigatório.' using errcode = '23505';
    end if;
    if extension in ('xls','xlsx','xlsm') and exists (
      select 1 from public.flow_attachments a where a.item_id = p_item_id and lower(a.file_name) ~ '\.(xls|xlsx|xlsm)$'
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

grant execute on function public.flow_register_attachment(uuid,uuid,text,text,text,bigint) to authenticated;

alter table public.flow_attachments drop constraint if exists flow_attachments_extension_valid;
alter table public.flow_attachments add constraint flow_attachments_extension_valid
check (coalesce(lower(substring(file_name, '\.([^.]+)$')), '') in
  ('pdf','xls','xlsx','xlsm','doc','docx','dwg'));

alter table public.flow_attachments drop constraint if exists flow_attachments_mime_valid;
alter table public.flow_attachments add constraint flow_attachments_mime_valid
check (mime_type in (
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
  'image/vnd.dwg'
));

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
     'image/vnd.dwg'
   ]
 where id = 'flow-anexos';

drop policy if exists "flow anexos envio" on storage.objects;
create policy "flow anexos envio"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'flow-anexos'
  and public.flow_attachment_request_from_path(name) is not null
  and public.flow_can_see_request(public.flow_attachment_request_from_path(name))
  and public.flow_attachment_slots_available(public.flow_attachment_request_from_path(name))
  and lower(substring(name, '\.([^.]+)$')) in ('pdf','xls','xlsx','xlsm','doc','docx','dwg')
);

-- ---------------------------------------------------------------------------
-- Painel: a leitura começa por novo/existente e logo depois mostra alocação.
-- ---------------------------------------------------------------------------
update public.flow_request_types
   set description = 'Solicite a postagem de um ou vários documentos. O GRCON Flow primeiro verifica nas LDs se cada item é novo ou já existe; quando existe, mostra a LD e a alocação encontrada antes das demais etapas.',
       panel_columns = '["requested_title","document","classification","allocation","ld_name","discipline","revision","last_grdt","internal_next_action","n1710_files","sigem_status","ld_stage","allocation_stage","sigem_stage"]'::jsonb,
       updated_at = now()
 where code = 'POSTAGEM_SIGEM';

-- Exportação passa a carregar o resultado objetivo e a auditoria do lançamento.
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
  i.excel_attachment_ready,
  -- novos campos sempre no fim para preservar a assinatura ordinal da view
  i.ld_presence_status,
  i.is_new_document,
  r.submitted_by_name,
  r.submitted_by_email,
  r.on_behalf_of
from public.flow_requests r
join public.flow_request_items i on i.request_id = r.id;

-- Acompanhamento já recebe a classificação principal e a alocação, mesmo que a
-- tela atual ainda escolha quanto disso mostrar.
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
  if not (
    r.requester_id = auth.uid()
    or r.submitted_by_id = auth.uid()
    or public.flow_is_staff()
  ) then
    raise exception 'Este protocolo não pertence à sua conta.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'item_number', i.item_number,
      'document', i.document,
      'requested_title', i.requested_title,
      'status', i.status,
      'answer', i.answer,
      'ld_presence_status', i.ld_presence_status,
      'is_new_document', i.is_new_document,
      'allocation', i.allocation,
      'ld_name', i.ld_name,
      'discipline', i.discipline,
      'revision', i.revision
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
    'requester_name', r.requester_name,
    'items', itens
  );
end;
$$;

grant execute on function public.flow_track_protocol(text) to authenticated;

-- Reprocessa os poucos itens existentes de tipos que usam LD com a lógica nova.
do $$
declare
  linha record;
begin
  for linha in
    select i.id
      from public.flow_request_items i
      join public.flow_requests r on r.id = i.request_id
      join public.flow_request_types t on t.id = r.type_id
     where t.uses_ld
  loop
    perform public.flow_triage_item(linha.id);
  end loop;
end $$;

commit;
