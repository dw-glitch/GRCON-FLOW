-- GRCON Flow 50 — corrige a validação normativa, torna a importação do Outlook
-- idempotente entre pessoas e fecha o acesso da base documental.
-- Aplicada no projeto em 20260902220429.
--
-- 1) o emitente da N-1710 deixa de ser o literal `C1O`;
-- 2) o mesmo e-mail importado por dois integrantes devolve um só protocolo;
-- 3) as RPCs da Base de LDs param de furar a RLS que restringe a base à equipe;
-- 4) `flow_triage_item` confere a permissão antes de escrever;
-- 5) `flow_request_origin` deixa de ser executável pelo papel anônimo.

begin;

-- ---------------------------------------------------------------------------
-- 1) Emitente da N-1710
--
-- `flow_repair_document_code` reconhece `…-5290.00-NNNNN-XXX-YYY-NNN` com
-- qualquer trinca no penúltimo grupo, mas `flow_document_code_is_normative`
-- exigia exatamente `C1O`. O resultado é que um documento legítimo de outro
-- emitente, ainda ausente das LDs, era marcado `CODIGO_INVALIDO_IGNORADO` em
-- vez de tratado como documento novo — e o código era apagado do item.
--
-- Que emitentes a empresa aceita é regra de catálogo, versionada em
-- `flow_norm_catalog_entries` e conferida na importação da LD por
-- `validarRegistro` (core.js). Não é regra de estrutura da norma, e por isso
-- não pertence a um literal aqui.
-- ---------------------------------------------------------------------------
create or replace function public.flow_document_code_is_normative(p_document text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  with codigo as (
    select public.flow_norm_text(public.flow_repair_document_code(p_document)) as valor
  )
  select coalesce(
    valor ~ '^[A-Z0-9]{3}_RNEST_[A-Z0-9]+_[0-9]+(?:\.[0-9]+){3}_(?:ADC|ARR|DBU|CVL|CTO|CRS|CDR|DOC|ELE|REQ|ETF|FSC|FOR|GER|HVAC|INSP|INS|PDMS|MEC|DIN|EST|PLA|PRS|PRJ|QUA|SMS|SEG|SIS|SUP|TEL|TUB)_[A-Z0-9][A-Z0-9.-]*_[A-Z0-9][A-Z0-9.-]*$'
    or valor ~ '^5900(?:\.[0-9]+){3}-[A-Z0-9]{3}-CV-[A-Z0-9]+-[0-9]{3,4}$'
    or valor ~ '^(?:[IAFLED]-)?(?:CE|CR|DB|DE|EC|ET|FD|IM|IS|LA|LD|LI|LO|MA|MC|MD|MO|PR|PT|RL|RM|CT|SIT)-5290\.00-[0-9]{4,5}-[A-Z0-9]{3}-[A-Z0-9]{3}-[0-9]{3,4}$',
    false
  )
  from codigo;
$$;

revoke all on function public.flow_document_code_is_normative(text) from public, anon;
grant execute on function public.flow_document_code_is_normative(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Permissão antes da escrita, em `flow_triage_item`
--
-- A função-base já recusa quem não pode triar o item, mas ela só é chamada
-- depois de o invólucro gravar o código corrigido. Hoje a exceção da base desfaz
-- essa gravação na mesma transação, então não há brecha aberta — mas a proteção
-- depende de nenhum `exception when others` aparecer aqui um dia. Conferir antes
-- de escrever custa uma consulta e não depende disso.
-- ---------------------------------------------------------------------------
create or replace function public.flow_triage_item(target_item uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  item_atual record;
  pedido record;
  codigo_original text;
  codigo_corrigido text;
  chave_corrigida text;
  chave_alternativa text := '';
  resultado jsonb;
  regra_ignorada text := 'O texto parecia um código, mas não corresponde a N-1710, ET ou CV. Após as correções determinísticas e a busca nas LDs vigentes, ele foi ignorado.';
begin
  select * into item_atual from public.flow_request_items where id = target_item;
  if not found then raise exception 'Item não encontrado.'; end if;

  select * into pedido from public.flow_requests where id = item_atual.request_id;
  if auth.uid() is not null
     and not (
       pedido.requester_id = auth.uid()
       or pedido.submitted_by_id = auth.uid()
       or public.flow_is_staff()
     ) then
    raise exception 'Sem permissão para triar este item.' using errcode = '42501';
  end if;

  codigo_original := coalesce(trim(item_atual.document), '');
  codigo_corrigido := public.flow_repair_document_code(codigo_original);

  if codigo_corrigido <> ''
     and public.flow_norm_text(codigo_corrigido) <> public.flow_norm_text(codigo_original) then
    chave_corrigida := public.flow_norm_text(codigo_corrigido);
    if chave_corrigida like '%\_RNEST\_%' then
      chave_alternativa := case
        when chave_corrigida ~ '_NT-' then replace(chave_corrigida, '_NT-', '_')
        else regexp_replace(chave_corrigida, '^((?:[^_]+_){6})(.+)$', '\1NT-\2')
      end;
    end if;
    update public.flow_request_items
       set document = codigo_corrigido,
           document_key = chave_corrigida,
           nt_key = chave_alternativa,
           reference = case
             when coalesce(reference, '') = '' then 'Código recebido: ' || codigo_original
             when reference not like '%' || codigo_original || '%'
               then reference || ' · Código recebido: ' || codigo_original
             else reference
           end,
           updated_at = now()
     where id = target_item;
  end if;

  resultado := public.flow_triage_item_base_v46(target_item);

  -- A função-base já tentou a forma original/corrigida e os códigos das LDs.
  -- Só então um formato não normativo deixa de ser tratado como documento novo.
  if coalesce(resultado->>'classification', '') = 'NAO_LOCALIZADO'
     and codigo_original <> ''
     and not public.flow_document_code_is_normative(
       coalesce(nullif(codigo_corrigido, ''), codigo_original)
     ) then
    update public.flow_request_items
       set document = '', document_key = '', nt_key = '', norm_family = '',
           reference = case
             when coalesce(reference, '') = '' then 'Código ignorado: ' || codigo_original
             when reference not like '%' || codigo_original || '%' then reference || ' · Código ignorado: ' || codigo_original
             else reference
           end,
           classification = 'CODIGO_INVALIDO_IGNORADO',
           ld_presence_status = 'IGNORADO_CODIGO_INVALIDO',
           is_new_document = null,
           needs_validation = false,
           occurrence_count = 0,
           triage_rule = regra_ignorada,
           official_title = '', revision = '', allocation = '',
           allocation_status = '', allocation_kind = '', last_grdt = '',
           sigem_status = '', discipline = '', ld_name = '',
           ld_version_label = '', all_lds = '',
           triaged_at = now(), updated_at = now()
     where id = target_item;

    update public.flow_triage_runs
       set classification = 'CODIGO_INVALIDO_IGNORADO',
           summary = 'Código fora da norma ignorado; nenhuma classificação NOVO/JÁ EXISTE foi feita.',
           result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
             'classification', 'CODIGO_INVALIDO_IGNORADO',
             'ld_presence_status', 'IGNORADO_CODIGO_INVALIDO',
             'is_new_document', null,
             'ignored_code', codigo_original,
             'rule', regra_ignorada
           )
     where id = (
       select id from public.flow_triage_runs
        where item_id = target_item order by run_number desc limit 1
     );

    resultado := resultado || jsonb_build_object(
      'classification', 'CODIGO_INVALIDO_IGNORADO',
      'ld_presence_status', 'IGNORADO_CODIGO_INVALIDO',
      'is_new_document', null,
      'summary', 'Código fora da norma ignorado; nenhuma classificação NOVO/JÁ EXISTE foi feita.',
      'rule', regra_ignorada,
      'ignored_code', codigo_original
    );
  elsif codigo_corrigido <> '' then
    resultado := resultado || jsonb_build_object(
      'received_code', codigo_original,
      'corrected_code', codigo_corrigido
    );
  end if;

  return resultado;
end;
$$;

revoke all on function public.flow_triage_item(uuid) from public, anon;
grant execute on function public.flow_triage_item(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) A Base de LDs volta a respeitar a própria RLS
--
-- `flow_ld_documents` só é visível para a equipe (`flow_is_staff()`), mas as
-- três RPCs de consulta eram `SECURITY DEFINER` sem verificação de papel: um
-- solicitante autenticado conseguia ler a base inteira pelo endpoint REST.
--
-- Trocar para `SECURITY INVOKER` resolve sem duplicar regra: a política já
-- existente passa a valer. A equipe continua enxergando tudo, e a chamada feita
-- de dentro de `flow_triage_item_base_v46` também continua funcionando, porque
-- ali a execução já corre como dono da tabela.
-- ---------------------------------------------------------------------------
alter function public.flow_lookup_document(text[]) security invoker;
alter function public.flow_lookup_document_flexible(text, text[]) security invoker;

-- O teto do `p_limit` some junto com o desvio de RLS, mas continua sendo bom
-- limite de sanidade: a tela pede 12 candidatos, nunca a base inteira.
create or replace function public.flow_search_by_title(p_query text, p_limit integer default 12)
returns jsonb
language sql
stable
security invoker
set search_path = 'public', 'extensions'
as $$
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
    limit least(greatest(coalesce(p_limit, 12), 1), 100)
  ) c;
$$;

revoke all on function public.flow_search_by_title(text, integer) from public, anon;
grant execute on function public.flow_search_by_title(text, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) O papel anônimo não executa `flow_request_origin`
--
-- Devolve apenas um enum, e explorar exigiria adivinhar o UUID de uma
-- solicitação. Ainda assim é a única função `SECURITY DEFINER` alcançável sem
-- sessão, e a flow_09 já havia fechado o acesso anônimo em todo o resto.
-- ---------------------------------------------------------------------------
revoke all on function public.flow_request_origin(uuid) from public, anon;
grant execute on function public.flow_request_origin(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5) Um e-mail, um protocolo — para toda a equipe
--
-- A idempotência do registro é `(submitted_by_id, client_request_id)`: ela
-- protege a mesma pessoa que clica duas vezes ou perde a resposta na rede, mas
-- não impede que duas pessoas da qualidade importem o mesmo e-mail e criem dois
-- protocolos. A chave que identifica o e-mail é o `internetMessageId`, e ela é
-- igual para todo mundo — então o índice também precisa ser.
--
-- Índice parcial: só alcança o que veio do Outlook. Solicitação registrada pelo
-- formulário ou pelo Registro rápido não tem esse campo e não é afetada.
-- ---------------------------------------------------------------------------
do $$
declare
  repetidos integer;
begin
  select count(*) into repetidos from (
    select form_data->>'outlook_external_id' as chave
      from public.flow_requests
     where coalesce(form_data->>'outlook_external_id', '') <> ''
     group by 1 having count(*) > 1
  ) duplicados;
  if repetidos > 0 then
    raise exception
      'Existem % e-mail(s) do Outlook com mais de um protocolo. Consolide-os antes de criar o índice único.', repetidos;
  end if;
end $$;

create unique index if not exists flow_requests_outlook_external_uidx
  on public.flow_requests ((form_data->>'outlook_external_id'))
  where coalesce(form_data->>'outlook_external_id', '') <> '';

create or replace function public.flow_create_request(
  p_type_code text, p_requester_name text, p_requester_area text,
  p_requester_contact text, p_summary text, p_description text,
  p_form_data jsonb, p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
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
  chave_outlook text;
begin
  if auth.uid() is null then
    raise exception 'É preciso estar autenticado para registrar uma solicitação.';
  end if;

  begin
    chave_cliente := nullif(coalesce(p_form_data, '{}'::jsonb)->>'_client_request_id', '')::uuid;
  exception when invalid_text_representation then
    raise exception 'Identificador de envio inválido.' using errcode = '22023';
  end;

  chave_outlook := nullif(coalesce(p_form_data, '{}'::jsonb)->>'outlook_external_id', '');

  -- O mesmo e-mail é o mesmo pedido, tenha sido importado por quem for. Esta
  -- consulta vem antes da chave por usuário justamente porque é a mais ampla.
  if chave_outlook is not null then
    select r.id into nova_solicitacao
      from public.flow_requests r
     where r.form_data->>'outlook_external_id' = chave_outlook;
    if found then
      return public.flow_request_receipt(nova_solicitacao);
    end if;
  end if;

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

  -- Concorrência real: dois cliques iguais, ou duas pessoas sobre o mesmo
  -- e-mail, podem chegar juntos. O `on conflict` cobre o reenvio do mesmo
  -- usuário; o `unique_violation` cobre a corrida entre pessoas, que colide no
  -- índice do `outlook_external_id`. Os dois terminam no mesmo lugar: buscar
  -- quem ganhou e devolver o recibo dele, nunca um segundo protocolo.
  begin
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
  exception when unique_violation then
    nova_solicitacao := null;
  end;

  if nova_solicitacao is null then
    select r.id into nova_solicitacao
      from public.flow_requests r
     where (chave_outlook is not null and r.form_data->>'outlook_external_id' = chave_outlook)
        or (chave_cliente is not null
            and r.submitted_by_id = auth.uid()
            and r.client_request_id = chave_cliente)
     limit 1;
    if nova_solicitacao is null then
      -- Nem chave de e-mail, nem chave de envio: a colisão foi no protocolo, o
      -- que só acontece se o contador estiver atrás do maior número já usado.
      raise exception 'Não foi possível gerar um protocolo livre. Confira a numeração em Painel → Acesso.'
        using errcode = '23505';
    end if;
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
      || case when em_nome_de_outro then ' · registrada em nome de ' || solicitante_nome else '' end
      || case when chave_outlook is not null then ' · importada do Outlook' else '' end,
    auth.uid(), ator_nome
  );

  perform public.flow_refresh_request_progress(nova_solicitacao);

  -- A triagem ficou deliberadamente fora desta transação. O protocolo já está
  -- seguro quando o navegador começa a processar cada item.
  return public.flow_request_receipt(nova_solicitacao);
end;
$$;

revoke all on function public.flow_create_request(text, text, text, text, text, text, jsonb, jsonb) from public, anon;
grant execute on function public.flow_create_request(text, text, text, text, text, text, jsonb, jsonb) to authenticated, service_role;

commit;
