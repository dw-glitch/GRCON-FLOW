-- ---------------------------------------------------------------------------
-- flow_31 — a família normativa (N-1710 / ET / CV) passa a ser guardada no item.
--
-- Do plano do cliente: "Documento já previsto → Identificação do tipo:
-- N-1710 / ET / CV → Gerar GRDT."
--
-- A LD traz o tipo do documento — RIR, PR, RL, CE, MC —, mas isso não é a mesma
-- pergunta. O que ele quer saber é qual norma rege aquele código, porque é ela
-- que define o que precisa ser entregue.
--
-- O aplicativo já sabe responder: `validateDocumentCode()` em core.js devolve
-- `family: "ET" | "CV" | "N-1710"` desde sempre, e é assim que a importação da
-- LD valida a codificação. Só que essa resposta era calculada e descartada —
-- nunca chegava à solicitação.
--
-- Esta migração traz a mesma regra para o banco, porque é o banco que escreve
-- o item: a triagem roda em `flow_triage_item`, e um cálculo feito no navegador
-- não alcançaria o item criado pelo servidor.
--
-- Sobre haver duas implementações da mesma regra: é deliberado e tem
-- precedente. `flow_is_n1710_li_mc` (flow_24) já é exatamente isso — uma regra
-- de codificação em SQL ao lado da de JavaScript. O que evita divergência é
-- teste, e há um em tests.mjs que lê as duas e falha se saírem de sincronia.
--
-- A regra abaixo foi conferida contra a base real antes de ser escrita:
-- 23.168 documentos das LDs vigentes, classificados pela planilha de origem na
-- importação, contra a classificação só pelo código (que é tudo o que uma
-- solicitação tem).
--
--   planilha ET      → ET       19.011 de 19.011
--   planilha N-1710  → N-1710    3.954 de  3.954   (inclui "N-1710 MOD")
--   planilha CV      → CV          182 de    182
--   planilha RNC     → N-1710       21           (core.js devolve o mesmo)
--
-- Acordo total nas três famílias. Vale registrar o erro que essa conferência
-- pegou: a primeira versão usava o regex estrito de `isEtDocument`, e ele
-- reprovava 34 documentos ET legítimos — EAP com três ou cinco níveis em vez de
-- quatro, ou sem o sétimo grupo. Não é `isEtDocument` que decide a família no
-- core.js; é `validateDocumentCode`, com o teste simples de conter "_RNEST_".
-- O regex estrito serve para validar a codificação, que é outra pergunta: um
-- documento pode ser ET e estar mal codificado — e é justamente esse que a
-- equipe precisa ver.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- A regra, centralizada — como `flow_is_n1710_li_mc` fez com a do par PDF+Excel.
--
-- A ordem dos ramos é a de `validateDocumentCode`: ET, depois CV, e N-1710 como
-- o caso geral. Inverter ET e CV mudaria a resposta de um currículo que também
-- contivesse "_RNEST_".
-- ---------------------------------------------------------------------------
create or replace function public.flow_document_family(p_document text)
returns text
language sql
immutable
security invoker
set search_path = public
as $$
  with canonico as (
    -- canonicalId() do core.js: sem acento, maiúsculas, espaço colapsado e
    -- espaço removido em volta de _ . -
    select regexp_replace(
             trim(regexp_replace(
               upper(translate(coalesce(p_document, ''),
                 'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ',
                 'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN')),
               '\s+', ' ', 'g')),
             '\s*([_.-])\s*', '\1', 'g') as valor
  )
  select case
    when coalesce(btrim(valor), '') = '' then ''
    -- Relatório sob a ET do contrato. O teste é o mesmo de validateDocumentCode:
    -- conter "_RNEST_". Deliberadamente frouxo — ver o cabeçalho.
    when valor like '%\_RNEST\_%' then 'ET'
    -- Currículo: cinco grupos previstos na ET. A extensão do arquivo sai antes,
    -- porque o código pode chegar com o nome do arquivo colado.
    when regexp_replace(valor, '\.(PDF|DOCX?|XLSX?|XLSM|DWG|DGN|PPTX?)$', '')
         ~ '^5900(?:\.\d+){3}-[A-Z0-9]{3}-CV-[A-Z0-9]+-\d{3,4}$' then 'CV'
    else 'N-1710'
  end
  from canonico;
$$;

revoke all on function public.flow_document_family(text) from public, anon;
grant execute on function public.flow_document_family(text) to authenticated;

-- ---------------------------------------------------------------------------
-- A coluna no item.
--
-- Vazia quando não há código: título solto ainda não tem norma que o reja, e
-- inventar "N-1710" ali seria afirmar o que ninguém apurou.
-- ---------------------------------------------------------------------------
alter table public.flow_request_items
  add column if not exists norm_family text not null default '';

alter table public.flow_request_items
  drop constraint if exists flow_request_items_norm_family_check;

alter table public.flow_request_items
  add constraint flow_request_items_norm_family_check
  check (norm_family in ('', 'N-1710', 'ET', 'CV'));

-- ---------------------------------------------------------------------------
-- O gatilho que já preparava o item passa a preencher a família.
--
-- É a função da flow_24 com uma linha a mais, ao lado da que ela já usa para
-- `requires_pdf_excel_pair` — mesma origem (o código do documento), mesmo
-- momento. A lista de colunas do gatilho não muda: `document` já está nela.
-- ---------------------------------------------------------------------------
create or replace function public.flow_prepare_item_workflow()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.requires_pdf_excel_pair := public.flow_is_n1710_li_mc(new.document);
  -- flow_31: a família normativa nasce junto, do mesmo código e no mesmo
  -- lugar. Se ela fosse calculada só na triagem, item sem triagem ficaria
  -- sem resposta; aqui ela acompanha o código sempre que ele muda.
  new.norm_family := public.flow_document_family(new.document);

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

-- ---------------------------------------------------------------------------
-- Preenche o que já está gravado.
--
-- UPDATE direto na coluna, e não um toque no `document` para acordar o gatilho:
-- o gatilho recalcula seis outros campos e poderia levantar a exceção do par
-- PDF+Excel num item já concluído, transformando um backfill em erro.
-- ---------------------------------------------------------------------------
update public.flow_request_items
   set norm_family = public.flow_document_family(document)
 where norm_family is distinct from public.flow_document_family(document);

-- ---------------------------------------------------------------------------
-- A view de exportação carrega a família, no fim, como manda a convenção.
-- ---------------------------------------------------------------------------
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
  r.on_behalf_of,
  -- flow_30: a bifurcação NOVO × JÁ PREVISTO, agregada por solicitação
  r.origin as request_origin,
  -- flow_31: qual norma rege o código deste item
  i.norm_family
from public.flow_requests r
join public.flow_request_items i on i.request_id = r.id;

-- ---------------------------------------------------------------------------
-- Conferência.
-- ---------------------------------------------------------------------------
select coalesce(nullif(norm_family, ''), '(sem código)') as familia,
       count(*) as itens
from public.flow_request_items
group by 1 order by 2 desc;

-- A regra respondendo aos casos que importam, sem depender de haver dado.
select codigo, public.flow_document_family(codigo) as familia
from (values
  ('C1O_RNEST_U32_3.1.1.1_INS_RIR_nt-SPE-AST-320019'),
  ('C1O_RNEST_U32_6.16.48_ELE_RILICE_510-CB-01A-01F'),
  ('5900.10.20.30-ABC-CV-ELE-001'),
  ('MA-5290.00-22313-142-C1O-075'),
  ('I-DE-5290.00-22313-142-C1O-075'),
  ('')
) as t(codigo);
