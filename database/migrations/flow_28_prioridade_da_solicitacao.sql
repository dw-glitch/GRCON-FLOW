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

-- ---------------------------------------------------------------------------
-- Quem registra o pedido pode marcá-lo como urgente.
--
-- `flow_update_request` é, e continua sendo, only-equipe: ela abre sete campos
-- de uma vez (status, responsável, prazo, resposta…) e nada disso é do
-- solicitante. Mas o papel padrão de todo cadastro novo é 'solicitante', então
-- pela função antiga a caixa "Esta solicitação é urgente" do formulário só
-- funcionaria para as três pessoas que hoje são administradoras — para
-- qualquer outra ela devolveria "Somente a equipe pode alterar solicitações."
-- e a urgência se perderia calada.
--
-- Esta função abre exatamente uma coisa, e só para quem tem direito a ela:
-- a prioridade do próprio pedido, por quem acabou de registrá-lo. Não é um
-- atalho para o resto — o painel continua passando por flow_update_request.
-- ---------------------------------------------------------------------------
create or replace function public.flow_set_request_priority(
  p_request_id uuid,
  p_priority text,
  p_note text default ''::text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  atual record;
begin
  if auth.uid() is null then
    raise exception 'É preciso estar autenticado para alterar a prioridade.';
  end if;

  if p_priority not in ('baixa', 'normal', 'alta', 'urgente') then
    raise exception 'Prioridade desconhecida: %', p_priority;
  end if;

  select * into atual from public.flow_requests where id = p_request_id for update;
  if not found then
    raise exception 'Solicitação não encontrada.';
  end if;

  -- A equipe pode sempre. Fora dela, só o dono do pedido, e só enquanto ele
  -- ainda está aberto: depois de concluído ou cancelado, mexer na prioridade
  -- não muda mais nada no atendimento e só embaralharia o histórico.
  if not public.flow_is_staff() then
    if coalesce(atual.submitted_by_id, atual.requester_id) is distinct from auth.uid() then
      raise exception 'Só a equipe ou quem registrou o pedido pode alterar a prioridade dele.';
    end if;
    if atual.status in ('concluido', 'cancelado') then
      raise exception 'Esta solicitação já foi encerrada.';
    end if;
  end if;

  if coalesce(atual.priority, '') = p_priority then
    return;
  end if;

  update public.flow_requests
     set priority = p_priority, updated_at = now()
   where id = p_request_id;

  -- Mesma forma que flow_update_request grava: 'solicitacao_alterada' com
  -- field/old/new. Assim a linha do tempo desenha a marcação do solicitante
  -- exatamente como desenha uma troca de prioridade feita pelo painel, e o
  -- nome de quem pediu urgência aparece junto.
  insert into public.flow_history (
    request_id, protocol, action, field, old_value, new_value, note, actor_id, actor_name
  ) values (
    p_request_id, atual.protocol, 'solicitacao_alterada', 'priority',
    coalesce(nullif(atual.priority, ''), 'normal'), p_priority,
    coalesce(p_note, ''), auth.uid(), public.flow_current_name()
  );
end;
$$;

revoke all on function public.flow_set_request_priority(uuid, text, text) from public;
grant execute on function public.flow_set_request_priority(uuid, text, text) to authenticated;
