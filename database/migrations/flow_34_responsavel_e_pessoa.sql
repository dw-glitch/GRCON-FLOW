-- ---------------------------------------------------------------------------
-- flow_34 — o responsável passa a ser uma pessoa, não um rótulo.
--
-- Pré-requisito de toda a notificação: para avisar o executor da atividade, o
-- sistema precisa saber QUEM ele é. Hoje não sabe. São três defeitos
-- encadeados, todos verificados no banco antes desta migração:
--
--   1. `owner_name` é texto livre, sem chave estrangeira. É um rótulo.
--   2. `owner_id` guarda `auth.uid()` — o id de quem ATRIBUIU, não de quem foi
--      atribuído. Se um administrador designa outra pessoa, a coluna aponta
--      para o administrador.
--   3. Nenhum código lê `owner_id`. Conferido: ele é escrito num lugar só e
--      lido em lugar nenhum. É uma coluna write-only carregando dado errado.
--
-- Esta migração não apaga `owner_id` — remover coluna é irreversível e ela não
-- atrapalha ninguém parada. O que ela faz é parar de escrevê-la e passar a
-- responder "quem executa" por `owner_profile_id`, com chave estrangeira de
-- verdade.
--
-- `owner_name` continua existindo, e por um motivo: o responsável pode ser
-- alguém sem conta no aplicativo. Nesse caso o nome fica registrado e
-- `owner_profile_id` fica nulo — e a tela avisa que essa pessoa não será
-- notificada, em vez de fingir que será.
-- ---------------------------------------------------------------------------

alter table public.flow_requests
  add column if not exists owner_profile_id uuid references public.flow_profiles(id) on delete set null,
  add column if not exists assigned_by_id   uuid references public.flow_profiles(id) on delete set null,
  add column if not exists assigned_at      timestamptz;

comment on column public.flow_requests.owner_id is
  'Obsoleta desde a flow_34: guardava quem atribuiu, não quem foi atribuído. Use owner_profile_id.';

-- ---------------------------------------------------------------------------
-- A regra de resolução, centralizada.
--
-- Um nome vira pessoa quando bate exatamente — normalizado, como o resto da
-- base compara texto — com o de UM perfil ativo da equipe. Duas pessoas com o
-- mesmo nome devolvem nulo de propósito: adivinhar qual das duas é pior do que
-- admitir que não dá para saber.
--
-- Fica em função própria porque duas portas escrevem responsável: a ficha, que
-- manda um nome escolhido na sugestão, e a alteração em lote, que manda o nome
-- digitado. As duas precisam resolver igual.
-- ---------------------------------------------------------------------------
create or replace function public.flow_resolve_owner_profile(p_name text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  -- `case` sobre a contagem, e não `having` com coluna solta: uma consulta com
  -- HAVING e sem GROUP BY é agregada, e Postgres recusa `select p.id` ali.
  -- Conferido contra o banco antes de escrever — a primeira forma dava
  -- "column p.id must appear in the GROUP BY clause".
  select case when count(*) = 1 then (array_agg(p.id))[1] end
    from public.flow_profiles p
   where p.active
     and p.role in ('operador', 'administrador', 'proprietario')
     and public.flow_norm_text(p.full_name) = public.flow_norm_text(p_name)
     and coalesce(btrim(p_name), '') <> ''
$$;

revoke all on function public.flow_resolve_owner_profile(text) from public, anon;
grant execute on function public.flow_resolve_owner_profile(text) to authenticated;

-- ---------------------------------------------------------------------------
-- A função de alteração passa a gravar a pessoa.
--
-- É a da flow_33 com o ramo do responsável trocado. Todo o resto — permissão,
-- campos aceitos, trava do par PDF+Excel da N-1710 e o histórico — permanece
-- palavra por palavra.
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
    -- flow_34: o responsável passa a ser uma pessoa, não um rótulo.
    --
    -- `owner_id` deixa de ser escrito aqui. Ele guardava `auth.uid()` — o id de
    -- quem ATRIBUIU, não de quem foi atribuído — e nunca foi lido por ninguém.
    -- Quem passa a responder "quem executa" é `owner_profile_id`, resolvido
    -- pela mesma função que a tela usa para sugerir nomes.
    update public.flow_requests
       set owner_name = p_value,
           owner_profile_id = public.flow_resolve_owner_profile(p_value),
           assigned_by_id = auth.uid(),
           assigned_at = case when coalesce(btrim(p_value), '') = '' then null else now() end,
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
-- Preenche o que já está gravado, pela mesma regra que passará a valer.
-- ---------------------------------------------------------------------------
update public.flow_requests
   set owner_profile_id = public.flow_resolve_owner_profile(owner_name)
 where coalesce(btrim(owner_name), '') <> ''
   and owner_profile_id is null;

-- Índice do recorte que a notificação e o painel de carga vão abrir: o que
-- cada pessoa tem em aberto.
create index if not exists flow_requests_responsavel_aberto_idx
  on public.flow_requests (owner_profile_id, due_at)
  where owner_profile_id is not null
    and status not in ('concluido', 'cancelado');

-- ---------------------------------------------------------------------------
-- Conferência.
-- ---------------------------------------------------------------------------
select
  (select prosrc like '%owner_id = auth.uid()%' from pg_proc
    where proname='flow_update_request' and pronamespace='public'::regnamespace)
    as ainda_grava_owner_id_errado,
  (select prosrc like '%flow_resolve_owner_profile%' from pg_proc
    where proname='flow_update_request' and pronamespace='public'::regnamespace)
    as passa_a_resolver_a_pessoa,
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='flow_requests'
      and column_name in ('owner_profile_id','assigned_by_id','assigned_at'))
    as colunas_novas_de_3;

-- Quantos responsáveis já gravados viraram pessoa, e quantos ficaram como
-- nome solto (pessoa sem conta, ou nome que não bate com ninguém da equipe).
select
  count(*) filter (where coalesce(btrim(owner_name),'') <> '')      as com_responsavel,
  count(*) filter (where owner_profile_id is not null)               as resolvidos_em_pessoa,
  count(*) filter (where coalesce(btrim(owner_name),'') <> ''
                     and owner_profile_id is null)                   as nome_solto
from public.flow_requests;
