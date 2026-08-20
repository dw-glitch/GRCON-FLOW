-- GRCON Flow — exclusão administrativa segura de solicitações.
--
-- Os anexos são removidos primeiro pelo Storage API no navegador. Esta função
-- remove a solicitação e deixa as chaves estrangeiras ON DELETE CASCADE
-- eliminarem itens, triagens, histórico, comentários, metadados de anexos e
-- notificações. A função é necessária porque DELETE direto permanece revogado
-- para authenticated; a autorização é refeita dentro do banco.

create or replace function public.flow_delete_request(p_request_id uuid)
returns table(deleted boolean, protocol text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  target_protocol text;
begin
  if actor is null or not public.flow_is_admin() then
    raise exception 'Sem permissão para excluir solicitações.' using errcode = '42501';
  end if;

  select r.protocol
    into target_protocol
  from public.flow_requests r
  where r.id = p_request_id
  for update;

  if target_protocol is null then
    return query select false, null::text;
    return;
  end if;

  delete from public.flow_requests
  where id = p_request_id;

  return query select true, target_protocol;
end;
$$;

revoke all on function public.flow_delete_request(uuid) from public, anon, authenticated;
grant execute on function public.flow_delete_request(uuid) to authenticated;

comment on function public.flow_delete_request(uuid) is
  'Exclui permanentemente uma solicitação somente para administrador ou proprietário.';
