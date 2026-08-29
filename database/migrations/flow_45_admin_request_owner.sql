-- GRCON Flow 45 — responsável válido, administrativo e concorrente.
--
-- A solicitação passa a aceitar responsável somente por UUID de um perfil
-- ativo da equipe. A troca é exclusiva de administrador/proprietário, usa
-- comparação otimista para não sobrescrever outra atribuição e registra nomes
-- legíveis no histórico. As demais alterações continuam disponíveis à equipe.

begin;

-- Mesmo que um usuário tente chamar o PostgREST diretamente, os campos de
-- atribuição só podem mudar dentro da função administrativa abaixo. A marca é
-- local à transação e nunca fica persistida na sessão.
create or replace function public.flow_guard_request_owner_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if row(new.owner_profile_id, new.owner_name, new.assigned_by_id, new.assigned_at)
       is not distinct from
     row(old.owner_profile_id, old.owner_name, old.assigned_by_id, old.assigned_at) then
    return new;
  end if;

  if coalesce(current_setting('grcon_flow.owner_change_authorized', true), '') <> '1'
     or auth.uid() is null
     or not public.flow_is_admin() then
    raise exception 'O responsável só pode ser alterado pela função administrativa.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.flow_guard_request_owner_update()
  from public, anon, authenticated;

drop trigger if exists flow_guard_request_owner_update on public.flow_requests;
create trigger flow_guard_request_owner_update
before update of owner_profile_id, owner_name, assigned_by_id, assigned_at
on public.flow_requests
for each row execute function public.flow_guard_request_owner_update();

create or replace function public.flow_set_request_owner(
  p_request_id uuid,
  p_owner_profile_id uuid,
  p_expected_owner_profile_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  pedido public.flow_requests%rowtype;
  novo_responsavel public.flow_profiles%rowtype;
  nome_anterior text;
  nome_novo text := '';
begin
  if auth.uid() is null or not public.flow_is_admin() then
    raise exception 'Somente administradores podem definir o responsável.'
      using errcode = '42501';
  end if;

  select * into pedido
    from public.flow_requests
   where id = p_request_id
   for update;
  if not found then
    raise exception 'Solicitação não encontrada.' using errcode = 'P0002';
  end if;

  if pedido.owner_profile_id is distinct from p_expected_owner_profile_id then
    raise exception 'O responsável foi alterado por outro administrador. Reabra a solicitação antes de tentar novamente.'
      using errcode = '40001';
  end if;

  if p_owner_profile_id is not null then
    select * into novo_responsavel
      from public.flow_profiles
     where id = p_owner_profile_id
       and active
       and role in ('operador', 'administrador', 'proprietario')
     for share;
    if not found then
      raise exception 'Selecione um usuário ativo da equipe como responsável.'
        using errcode = '22023';
    end if;
    nome_novo := btrim(coalesce(novo_responsavel.full_name, ''));
    if nome_novo = '' then
      raise exception 'O usuário selecionado não possui nome cadastrado.'
        using errcode = '22023';
    end if;
  end if;

  if pedido.owner_profile_id is not distinct from p_owner_profile_id then
    return jsonb_build_object(
      'id', pedido.id,
      'owner_profile_id', pedido.owner_profile_id,
      'owner_name', coalesce(pedido.owner_name, ''),
      'changed', false
    );
  end if;

  nome_anterior := coalesce(pedido.owner_name, '');

  perform set_config('grcon_flow.owner_change_authorized', '1', true);

  update public.flow_requests
     set owner_profile_id = p_owner_profile_id,
         owner_name = nome_novo,
         assigned_by_id = auth.uid(),
         assigned_at = case when p_owner_profile_id is null then null else now() end,
         updated_at = now()
   where id = pedido.id;

  perform set_config('grcon_flow.owner_change_authorized', '', true);

  insert into public.flow_history (
    request_id, protocol, action, field, old_value, new_value,
    note, actor_id, actor_name
  ) values (
    pedido.id,
    pedido.protocol,
    'responsavel_alterado',
    'owner_name',
    nome_anterior,
    nome_novo,
    case
      when p_owner_profile_id is null then 'Responsável removido pela administração.'
      when pedido.owner_profile_id is null then 'Responsável definido pela administração.'
      else 'Responsável alterado pela administração.'
    end,
    auth.uid(),
    public.flow_current_name()
  );

  return jsonb_build_object(
    'id', pedido.id,
    'owner_profile_id', p_owner_profile_id,
    'owner_name', nome_novo,
    'changed', true
  );
end;
$$;

revoke all on function public.flow_set_request_owner(uuid,uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.flow_set_request_owner(uuid,uuid,uuid)
  to authenticated;

-- Fecha o caminho antigo de nome livre. Todos os outros campos preservam o
-- comportamento vigente e continuam disponíveis à equipe.
create or replace function public.flow_update_request(
  p_request_id uuid, p_field text, p_value text, p_note text default ''::text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  atual public.flow_requests%rowtype;
  anterior text;
begin
  if auth.uid() is null or not public.flow_is_staff() then
    raise exception 'Somente a equipe pode alterar solicitações.'
      using errcode = '42501';
  end if;
  if p_field = 'owner_name' then
    raise exception 'Use a seleção administrativa de responsável.'
      using errcode = '42501';
  end if;
  if p_field not in ('status','priority','due_at','answer','answer_source','summary') then
    raise exception 'Campo não permitido: %', p_field;
  end if;

  select * into atual
    from public.flow_requests
   where id = p_request_id
   for update;
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
    request_id, protocol, action, field, old_value, new_value,
    note, actor_id, actor_name
  ) values (
    p_request_id, atual.protocol, 'solicitacao_alterada', p_field,
    coalesce(anterior,''), coalesce(p_value,''), coalesce(p_note,''),
    auth.uid(), public.flow_current_name()
  );
end;
$$;

revoke all on function public.flow_update_request(uuid,text,text,text)
  from public, anon;
grant execute on function public.flow_update_request(uuid,text,text,text)
  to authenticated;

create index if not exists flow_requests_assigned_by_idx
  on public.flow_requests (assigned_by_id)
  where assigned_by_id is not null;

commit;
