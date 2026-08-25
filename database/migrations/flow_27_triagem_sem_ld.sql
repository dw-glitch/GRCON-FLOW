-- ---------------------------------------------------------------------------
-- flow_27 — a triagem também roda para tipo que não consulta LD.
--
-- `flow_triage_item` sempre soube responder por esses tipos: o primeiro ramo
-- dela grava TRIAGEM_NAO_APLICAVEL com o resumo "Triagem em LD não se aplica a
-- este tipo de solicitação". Só que `flow_create_request` protegia a chamada
-- com `if tipo.uses_ld then` — e a regra nunca era alcançada.
--
-- O efeito aparecia na tela. Os itens desses pedidos ficavam com classificação
-- vazia, e o painel mostrava "—", o mesmo traço que ele usa para campo não
-- apurado: quem lia não distinguia "este tipo não passa por LD" de "ninguém
-- triou isto ainda". Na base, todos os itens de IMPRESSAO (hoje o único tipo
-- com uses_ld = false) estavam assim, com zero execuções de triagem
-- registradas, enquanto todo tipo com uses_ld = true tinha triagem em 100% dos
-- itens.
--
-- Triar todo tipo não custa consulta à LD: o ramo do tipo sem LD decide antes
-- de tocar no índice documental.
--
-- A função abaixo é a da flow_25 com essa única condição trocada.
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
  -- Para todo tipo, e não só para quem usa LD: `flow_triage_item` decide pelo
  -- tipo sem LD logo no primeiro ramo, antes de tocar no índice documental, e é
  -- ele que grava TRIAGEM_NAO_APLICAVEL. Sob a condição antiga essa regra
  -- existia e nunca era alcançada.
  begin
    triagem_resultado := public.flow_triage_request(nova_solicitacao);
    triagem_ok := true;
  exception when others then
    triagem_erro := sqlerrm;
    insert into public.flow_history (request_id, protocol, action, note, actor_id, actor_name)
    values (nova_solicitacao, novo_protocolo, 'triagem_falhou', triagem_erro, auth.uid(), ator_nome);
  end;

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

-- ---------------------------------------------------------------------------
-- Corrige o que já está gravado: itens de tipos sem LD que ficaram sem
-- classificação porque a triagem nunca rodou neles.
--
-- O recorte é estreito de propósito. Um item de tipo que usa LD e está sem
-- classificação seria outro problema — provavelmente uma triagem que falhou —
-- e esta migração não o adivinha nem o mascara.
-- ---------------------------------------------------------------------------
update public.flow_request_items i
   set classification = 'TRIAGEM_NAO_APLICAVEL',
       ld_presence_status = coalesce(nullif(i.ld_presence_status, ''), 'NAO_APLICAVEL'),
       triage_rule = coalesce(nullif(i.triage_rule, ''),
                              'Triagem em LD não se aplica a este tipo de solicitação.'),
       updated_at = now()
  from public.flow_requests r
  join public.flow_request_types t on t.id = r.type_id
 where i.request_id = r.id
   and not t.uses_ld
   and coalesce(i.classification, '') = '';
