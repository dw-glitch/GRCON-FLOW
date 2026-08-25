-- ---------------------------------------------------------------------------
-- flow_28 — a prioridade da solicitação passa a ser escrita pela tela.
--
-- `flow_requests.priority` existe desde o começo, com `default 'normal'`, e
-- `flow_update_request` já aceitava o campo. O que faltava era vocabulário
-- garantido: a coluna é `text` sem nenhuma restrição, então qualquer palavra
-- entrava. Enquanto ninguém escrevia nela isso não incomodava; agora o painel e
-- o formulário escrevem, e um valor fora da lista viraria uma linha que a tela
-- não sabe desenhar e nenhum filtro alcança.
--
-- Os quatro valores são os mesmos que `flow_request_types.default_priority` já
-- restringe desde a flow_02 — esta migração só faz a solicitação concordar com
-- o tipo que a originou.
--
-- Seguro de aplicar: na base toda, todas as solicitações estão em 'normal'.
-- A normalização abaixo existe para o caso de alguma linha ter escapado antes
-- da restrição, e não apaga informação: leva ao padrão apenas o que já era
-- ilegível para o aplicativo.
-- ---------------------------------------------------------------------------

update public.flow_requests
   set priority = 'normal'
 where coalesce(priority, '') not in ('baixa', 'normal', 'alta', 'urgente');

alter table public.flow_requests
  alter column priority set default 'normal';

alter table public.flow_requests
  drop constraint if exists flow_requests_priority_check;

alter table public.flow_requests
  add constraint flow_requests_priority_check
  check (priority in ('baixa', 'normal', 'alta', 'urgente'));

-- Índice do recorte que o cartão "Urgentes em aberto" abre a cada carregamento
-- do painel: prioridade alta ou urgente, entre as que ainda estão abertas.
create index if not exists flow_requests_prioridade_aberta_idx
  on public.flow_requests (priority, created_at desc)
  where status not in ('concluido', 'cancelado');
