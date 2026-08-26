-- ---------------------------------------------------------------------------
-- flow_33 — o solicitante deixa de ser notificado.
--
-- Decisão do cliente: quem precisa ser avisado é o executor da atividade — as
-- pessoas da equipe de qualidade —, e o aviso vai para o canal do Teams. O
-- solicitante não recebe notificação.
--
-- Hoje `flow_update_request` cria um aviso interno para `requester_id` sempre
-- que o status muda. Isso contraria a decisão, e some aqui.
--
-- O que NÃO muda, de propósito:
--
--   • `flow_notify_new_request` continua intacta. Ela avisa apenas quem tem
--     papel de operador, administrador ou proprietário — exatamente o público
--     executor — e já exclui o solicitante quando ele é da equipe. É o aviso
--     que a decisão quer manter, não o que ela quer tirar.
--   • A tabela `flow_notifications` e a caixa de entrada seguem como estão:
--     são a fonte da verdade dos avisos, e o Teams será entrega, não
--     substituto.
--   • Nada do histórico é apagado. Conferido antes de escrever: os 3 avisos
--     gravados são todos `nova_solicitacao` para a equipe, nenhum para
--     solicitante. Não há o que limpar — e, se houvesse, aviso já entregue é
--     registro do que aconteceu, não sujeira.
--
-- A função abaixo é a da flow_24 com o bloco de notificação removido. Todo o
-- resto — permissão, campos aceitos, trava do par PDF+Excel da N-1710 e o
-- registro no histórico — permanece palavra por palavra.
-- ---------------------------------------------------------------------------

create or replace function public.flow_update_request(
  p_request_id uuid, p_field text, p_value text, p_note text default ''::text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  atual record;
  anterior text;
begin
  if not public.flow_is_staff() then
    raise exception 'Somente a equipe pode alterar solicitações.';
  end if;
  if p_field not in ('status','owner_name','priority','due_at','answer','answer_source','summary') then
    raise exception 'Campo não permitido: %', p_field;
  end if;

  select * into atual from public.flow_requests where id = p_request_id for update;
  if not found then raise exception 'Solicitação não encontrada.'; end if;

  if p_field = 'status' and p_value = 'concluido' and exists (
    select 1
      from public.flow_request_items i
     where i.request_id = p_request_id
       and public.flow_is_n1710_li_mc(i.document)
       and not (i.pdf_attachment_ready and i.excel_attachment_ready)
  ) then
    raise exception 'Há documento LI/MC da N-1710 sem o conjunto PDF + Excel. Complete os arquivos antes de concluir a solicitação.'
      using errcode = '23514';
  end if;

  anterior := case p_field
    when 'status' then atual.status
    when 'owner_name' then atual.owner_name
    when 'priority' then atual.priority
    when 'due_at' then coalesce(atual.due_at::text,'')
    when 'answer' then atual.answer
    when 'answer_source' then atual.answer_source
    when 'summary' then atual.summary
    else '' end;

  if coalesce(anterior,'') = coalesce(p_value,'') then return; end if;

  if p_field = 'status' then
    update public.flow_requests
       set status = p_value,
           closed_at = case when p_value in ('concluido','cancelado') then now() else null end,
           updated_at = now()
     where id = p_request_id;
  elsif p_field = 'owner_name' then
    update public.flow_requests set owner_name = p_value, owner_id = auth.uid(), updated_at = now()
     where id = p_request_id;
  elsif p_field = 'priority' then
    update public.flow_requests set priority = p_value, updated_at = now() where id = p_request_id;
  elsif p_field = 'due_at' then
    update public.flow_requests set due_at = nullif(p_value,'')::date, updated_at = now() where id = p_request_id;
  elsif p_field = 'answer' then
    update public.flow_requests
       set answer = p_value, answered_by = auth.uid(), answered_at = now(), updated_at = now()
     where id = p_request_id;
  elsif p_field = 'answer_source' then
    update public.flow_requests set answer_source = p_value, updated_at = now() where id = p_request_id;
  elsif p_field = 'summary' then
    update public.flow_requests set summary = p_value, updated_at = now() where id = p_request_id;
  end if;

  insert into public.flow_history (
    request_id, protocol, action, field, old_value, new_value, note, actor_id, actor_name
  ) values (
    p_request_id, atual.protocol, 'solicitacao_alterada', p_field,
    coalesce(anterior,''), coalesce(p_value,''), coalesce(p_note,''),
    auth.uid(), public.flow_current_name()
  );

end;
$$;
grant execute on function public.flow_update_request(uuid,text,text,text) to authenticated;

-- ---------------------------------------------------------------------------
-- Conferência: a função não pode mais escrever em flow_notifications, e a de
-- registro de solicitação tem que continuar escrevendo.
-- ---------------------------------------------------------------------------
select
  (select prosrc like '%flow_notifications%' from pg_proc
    where proname = 'flow_update_request' and pronamespace = 'public'::regnamespace)
    as alteracao_ainda_notifica,
  (select prosrc like '%flow_notifications%' from pg_proc
    where proname = 'flow_notify_new_request' and pronamespace = 'public'::regnamespace)
    as registro_ainda_notifica_a_equipe;
