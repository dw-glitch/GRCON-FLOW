-- GRCON Flow 46 — triagem normativa e sequência administrativa de protocolos.
-- 2026-09-01
--
-- 1) tenta recuperar apenas correções determinísticas de código antes da LD;
-- 2) um falso código que não encontra a LD e não passa na norma é ignorado;
-- 3) ausência de código continua como identificação pendente, nunca como novo;
-- 4) administradores podem definir o próximo número sem alterar protocolos já usados.

begin;

alter table public.flow_request_items
  drop constraint if exists flow_request_items_ld_presence_status_check;
alter table public.flow_request_items
  add constraint flow_request_items_ld_presence_status_check
  check (ld_presence_status in (
    'NAO_AVALIADO', 'NOVO', 'JA_EXISTE', 'JA_EXISTE_DIVERGENTE',
    'PENDENTE_IDENTIFICACAO', 'POSSIVEL_EXISTENTE',
    'IGNORADO_CODIGO_INVALIDO', 'NAO_APLICAVEL'
  ));

-- Recupera apenas formatos que podem ser corrigidos sem escolher entre dois
-- documentos: caixa, travessão, underline da N-1710 e sufixos do arquivo.
create or replace function public.flow_repair_document_code(p_document text)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  normalizado text;
  fonte_et text;
  fonte_hifen text;
  achado text[];
begin
  normalizado := public.flow_norm_text(coalesce(p_document, ''));
  normalizado := regexp_replace(normalizado, '[[:space:]]*([_.-])[[:space:]]*', '\1', 'g');
  normalizado := regexp_replace(normalizado, '\.(PDF|DOCX?|XLSX?|XLSM|DWG|DGN|PPTX?)$', '', 'i');
  fonte_et := replace(normalizado, ' ', '_');
  fonte_hifen := replace(normalizado, '_', '-');

  achado := regexp_match(
    normalizado,
    '(?:^|[^A-Z0-9])([A-Z0-9]{3})-RNEST-([A-Z0-9]+)-([0-9]+(?:\.[0-9]+){3})-(ADC|ARR|DBU|CVL|CTO|CRS|CDR|DOC|ELE|REQ|ETF|FSC|FOR|GER|HVAC|INSP|INS|PDMS|MEC|DIN|EST|PLA|PRS|PRJ|QUA|SMS|SEG|SIS|SUP|TEL|TUB)-([A-Z0-9]{2,10})-([A-Z0-9][A-Z0-9.-]*)(?:$|[^A-Z0-9])'
  );
  if achado is not null then
    return achado[1] || '_RNEST_' || achado[2] || '_' || achado[3] || '_'
      || achado[4] || '_' || achado[5] || '_'
      || regexp_replace(achado[6], '^NT-', 'nt-');
  end if;

  achado := regexp_match(
    fonte_et,
    '(?:^|[^A-Z0-9])([A-Z0-9]{3}_RNEST_[A-Z0-9]+_[0-9]+(?:\.[0-9]+){3}_(?:ADC|ARR|DBU|CVL|CTO|CRS|CDR|DOC|ELE|REQ|ETF|FSC|FOR|GER|HVAC|INSP|INS|PDMS|MEC|DIN|EST|PLA|PRS|PRJ|QUA|SMS|SEG|SIS|SUP|TEL|TUB)_[A-Z0-9][A-Z0-9.-]*_[A-Z0-9][A-Z0-9.-]*)(?:$|[^A-Z0-9])'
  );
  if achado is not null then
    return regexp_replace(achado[1], '_NT-', '_nt-', 'g');
  end if;

  achado := regexp_match(
    fonte_hifen,
    '(?:^|[^A-Z0-9])(5900(?:\.[0-9]+){3}-[A-Z0-9]{3}-CV-[A-Z0-9]+-[0-9]{3,4})(?:$|[^A-Z0-9])'
  );
  if achado is not null then return achado[1]; end if;

  achado := regexp_match(
    fonte_hifen,
    '(?:^|[^A-Z0-9])((?:[IAFLED]-)?(?:CE|CR|DB|DE|EC|ET|FD|IM|IS|LA|LD|LI|LO|MA|MC|MD|MO|PR|PT|RL|RM|CT|SIT)-5290\.00-[0-9]{4,5}-[A-Z0-9]{3}-[A-Z0-9]{3}-[0-9]{3,4})(?:$|[^A-Z0-9])'
  );
  if achado is not null then return achado[1]; end if;

  return '';
end;
$$;

revoke all on function public.flow_repair_document_code(text) from public, anon;
grant execute on function public.flow_repair_document_code(text) to authenticated, service_role;

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
    or valor ~ '^(?:[IAFLED]-)?(?:CE|CR|DB|DE|EC|ET|FD|IM|IS|LA|LD|LI|LO|MA|MC|MD|MO|PR|PT|RL|RM|CT|SIT)-5290\.00-[0-9]{4,5}-[A-Z0-9]{3}-C1O-[0-9]{3,4}$',
    false
  )
  from codigo;
$$;

revoke all on function public.flow_document_code_is_normative(text) from public, anon;
grant execute on function public.flow_document_code_is_normative(text) to authenticated, service_role;

-- Conserva a triagem consolidada até a flow_45 e coloca a validação normativa
-- como uma camada final. A função-base continua inacessível diretamente.
alter function public.flow_triage_item(uuid) rename to flow_triage_item_base_v46;
revoke all on function public.flow_triage_item_base_v46(uuid) from public, anon, authenticated;
grant execute on function public.flow_triage_item_base_v46(uuid) to service_role;

create or replace function public.flow_triage_item(target_item uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  item_atual record;
  codigo_original text;
  codigo_corrigido text;
  chave_corrigida text;
  chave_alternativa text := '';
  resultado jsonb;
  regra_ignorada text := 'O texto parecia um código, mas não corresponde a N-1710, ET ou CV. Após as correções determinísticas e a busca nas LDs vigentes, ele foi ignorado.';
begin
  select * into item_atual from public.flow_request_items where id = target_item;
  if not found then raise exception 'Item não encontrado.'; end if;

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

-- Registro interno da troca de sequência. Não é exposto pela Data API.
create table if not exists public.flow_protocol_adjustments (
  id uuid primary key default gen_random_uuid(),
  year integer not null,
  previous_last_number integer not null,
  next_number integer not null,
  changed_by uuid references auth.users(id) on delete set null,
  changed_by_name text not null default '',
  created_at timestamptz not null default now()
);

alter table public.flow_protocol_adjustments enable row level security;
revoke all on table public.flow_protocol_adjustments from public, anon, authenticated;

create or replace function public.flow_protocol_settings()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ano integer := extract(year from now())::integer;
  ultimo integer := 0;
  maior_usado integer := 0;
begin
  if not public.flow_is_admin() then
    raise exception 'Somente administradores podem consultar a numeração.';
  end if;

  select coalesce(last_number, 0) into ultimo
    from public.flow_protocol_counters where year = ano;
  select coalesce(max(substring(protocol from 11)::integer), 0) into maior_usado
    from public.flow_requests
   where protocol ~ ('^FLOW-' || ano::text || '-[0-9]+$');

  return jsonb_build_object(
    'year', ano,
    'last_number', ultimo,
    'last_protocol', case when ultimo > 0 then 'FLOW-' || ano::text || '-' || lpad(ultimo::text, 6, '0') else '' end,
    'next_number', greatest(ultimo, maior_usado) + 1,
    'minimum_next_number', greatest(ultimo, maior_usado) + 1
  );
end;
$$;

revoke all on function public.flow_protocol_settings() from public, anon;
grant execute on function public.flow_protocol_settings() to authenticated;

create or replace function public.flow_set_next_protocol(p_next_number integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ano integer := extract(year from now())::integer;
  ultimo integer := 0;
  maior_usado integer := 0;
  minimo integer;
begin
  if not public.flow_is_admin() then
    raise exception 'Somente administradores podem alterar a numeração.';
  end if;
  if p_next_number is null or p_next_number < 1 or p_next_number > 999999 then
    raise exception 'Informe um número inteiro entre 1 e 999999.';
  end if;

  insert into public.flow_protocol_counters(year, last_number)
  values (ano, 0)
  on conflict (year) do nothing;

  select last_number into ultimo
    from public.flow_protocol_counters where year = ano for update;
  select coalesce(max(substring(protocol from 11)::integer), 0) into maior_usado
    from public.flow_requests
   where protocol ~ ('^FLOW-' || ano::text || '-[0-9]+$');
  minimo := greatest(ultimo, maior_usado) + 1;

  if p_next_number < minimo then
    raise exception 'O próximo número deve ser no mínimo % para não repetir nem retroceder a sequência.', minimo;
  end if;

  insert into public.flow_protocol_adjustments(
    year, previous_last_number, next_number, changed_by, changed_by_name
  ) values (
    ano, ultimo, p_next_number, auth.uid(), public.flow_current_name()
  );

  update public.flow_protocol_counters
     set last_number = p_next_number - 1
   where year = ano;

  return jsonb_build_object(
    'year', ano,
    'previous_last_number', ultimo,
    'next_number', p_next_number,
    'next_protocol', 'FLOW-' || ano::text || '-' || lpad(p_next_number::text, 6, '0')
  );
end;
$$;

revoke all on function public.flow_set_next_protocol(integer) from public, anon;
grant execute on function public.flow_set_next_protocol(integer) to authenticated;

commit;
