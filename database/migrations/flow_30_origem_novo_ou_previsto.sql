-- ---------------------------------------------------------------------------
-- flow_30 — a bifurcação NOVO × JÁ PREVISTO vira resposta da solicitação.
--
-- A folha do cliente separa a demanda em dois caminhos depois da triagem:
-- NOVO ou JÁ PREVISTO. O aplicativo já responde isso, e com mais nuance do que
-- a folha previa: desde a flow_25 cada item guarda `ld_presence_status`, com
-- sete valores restritos por constraint, e `is_new_document`.
--
-- O que faltava era a resposta no nível em que o painel lista. O painel lista
-- solicitações; a presença em LD é do item. Sem um agregado, a bifurcação
-- central do desenho dele não podia ser coluna, nem filtro, nem ordenação, nem
-- sair no Excel — ficava diluída dentro do rótulo da classificação, legível só
-- para quem abrisse o pedido item a item.
--
-- Esta migração não inventa vocabulário nem recalcula nada: lê o que a triagem
-- já gravou e resume por solicitação, do mesmo jeito que `items_total` e
-- `items_done` já resumem o andamento. Segue o precedente da casa.
--
-- Uma armadilha encontrada e fechada aqui: o gatilho `flow_items_progress`
-- disparava apenas em `UPDATE OF status`. A triagem escreve `classification` e
-- `ld_presence_status` — nunca `status` — então o agregado nasceria certo no
-- registro e congelaria na primeira triagem. A lista de colunas do gatilho é
-- ampliada abaixo.
-- ---------------------------------------------------------------------------

alter table public.flow_requests
  add column if not exists origin text not null default '';

alter table public.flow_requests
  drop constraint if exists flow_requests_origin_check;

alter table public.flow_requests
  add constraint flow_requests_origin_check
  check (origin in ('', 'novo', 'previsto', 'misto', 'a_confirmar', 'nao_aplicavel'));

-- ---------------------------------------------------------------------------
-- A regra de agregação, em função própria para o painel, a exportação e
-- qualquer consulta futura lerem a mesma resposta.
--
-- A precedência é a parte que decide, e ela tem um princípio: não afirmar um
-- caminho enquanto algum documento do pedido ainda não tem código confirmado.
-- Um item pendente de identificação pode virar novo ou existente — dizer
-- "JÁ PREVISTO" porque os outros dois já existem esconderia justamente o
-- documento que dá trabalho. Por isso 'a_confirmar' vence 'misto', que vence
-- os dois caminhos puros.
--
--   ''             nada avaliado ainda (NAO_AVALIADO em tudo)
--   a_confirmar    algum item sem código confirmado
--   misto          o pedido tem documento novo e documento já previsto
--   novo           todos os avaliados são novos
--   previsto       todos os avaliados já constam nas LDs
--   nao_aplicavel  tipo de serviço que não consulta LD
-- ---------------------------------------------------------------------------
create or replace function public.flow_request_origin(target_request uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  with presencas as (
    select
      count(*) filter (where ld_presence_status = 'NOVO')                          as novos,
      count(*) filter (where ld_presence_status in ('JA_EXISTE', 'JA_EXISTE_DIVERGENTE')) as previstos,
      count(*) filter (where ld_presence_status in ('PENDENTE_IDENTIFICACAO', 'POSSIVEL_EXISTENTE')) as a_confirmar,
      count(*) filter (where ld_presence_status = 'NAO_APLICAVEL')                 as nao_aplicaveis,
      count(*)                                                                     as total
    from public.flow_request_items
    where request_id = target_request
  )
  select case
    when total = 0                                        then ''
    when a_confirmar > 0                                  then 'a_confirmar'
    when novos > 0 and previstos > 0                      then 'misto'
    when novos > 0                                        then 'novo'
    when previstos > 0                                    then 'previsto'
    when nao_aplicaveis > 0                               then 'nao_aplicavel'
    else ''
  end
  from presencas;
$$;

-- ---------------------------------------------------------------------------
-- O mesmo lugar que já mantinha items_total e items_done passa a manter a
-- origem. Uma função só, um UPDATE só: a solicitação nunca fica com o
-- andamento de agora e a origem de antes.
-- ---------------------------------------------------------------------------
create or replace function public.flow_refresh_request_progress(target_request uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  total integer;
  prontos integer;
  origem text;
begin
  select count(*), count(*) filter (where status in ('concluido','cancelado'))
    into total, prontos
  from public.flow_request_items where request_id = target_request;

  origem := public.flow_request_origin(target_request);

  update public.flow_requests
     set items_total = coalesce(total, 0),
         items_done = coalesce(prontos, 0),
         origin = coalesce(origem, ''),
         updated_at = now()
   where id = target_request;
end;
$$;

-- ---------------------------------------------------------------------------
-- O gatilho passa a ouvir as colunas que a triagem escreve.
--
-- `flow_items_progress_trigger` não muda: ela só repassa o request_id. O que
-- muda é quando ela é chamada.
-- ---------------------------------------------------------------------------
drop trigger if exists flow_items_progress on public.flow_request_items;

create trigger flow_items_progress
  after insert or delete or update of status, classification, ld_presence_status
  on public.flow_request_items
  for each row execute function public.flow_items_progress_trigger();

-- ---------------------------------------------------------------------------
-- Preenche o que já está gravado. Vai pela função de refresh, e não por um
-- UPDATE próprio, para o backfill usar exatamente a mesma regra que o gatilho
-- usará daqui em diante — duas regras equivalentes hoje divergem amanhã.
-- ---------------------------------------------------------------------------
do $$
declare
  alvo uuid;
  atualizadas integer := 0;
begin
  for alvo in select id from public.flow_requests loop
    perform public.flow_refresh_request_progress(alvo);
    atualizadas := atualizadas + 1;
  end loop;
  raise notice 'Solicitações com origem recalculada: %', atualizadas;
end $$;

-- Índice do recorte que o filtro do painel abre. Parcial nas abertas, como o
-- da prioridade: origem de pedido encerrado não é fila de trabalho.
create index if not exists flow_requests_origem_aberta_idx
  on public.flow_requests (origin, created_at desc)
  where status not in ('concluido', 'cancelado');


-- ---------------------------------------------------------------------------
-- A view de exportação passa a carregar a origem.
--
-- É a mesma definição da flow_25 com uma coluna a mais, no fim: `create or
-- replace view` exige que as colunas existentes fiquem na mesma ordem, e a
-- convenção desta base é acrescentar sempre no fim para preservar a assinatura
-- ordinal. O nome sai como `request_origin` porque a view mistura colunas da
-- solicitação e do item, e `origin` sozinho não diria de qual das duas.
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
  r.origin as request_origin
from public.flow_requests r
join public.flow_request_items i on i.request_id = r.id;

-- ---------------------------------------------------------------------------
-- Conferência. As duas consultas abaixo devolvem o retrato depois de aplicar.
-- ---------------------------------------------------------------------------
select coalesce(nullif(origin, ''), '(não avaliada)') as origem,
       count(*) as solicitacoes
from public.flow_requests
group by 1
order by 2 desc;

select coalesce(nullif(ld_presence_status, ''), '(vazio)') as presenca_no_item,
       count(*) as itens
from public.flow_request_items
group by 1
order by 2 desc;
