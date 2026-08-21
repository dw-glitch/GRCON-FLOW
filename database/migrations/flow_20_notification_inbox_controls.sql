-- GRCON Flow — controle seguro da caixa de notificações.
--
-- A notificação pertence ao destinatário. Ele pode consultar, confirmar a
-- leitura e excluir somente as próprias linhas; o navegador não recebe
-- permissão para inserir avisos, pois eles continuam sendo gerados pelo
-- gatilho de novas solicitações.

alter table public.flow_notifications enable row level security;

drop policy if exists "notificacoes criadas pela equipe" on public.flow_notifications;
drop policy if exists "notificacoes proprias" on public.flow_notifications;
drop policy if exists "notificacoes marcadas como lidas" on public.flow_notifications;
drop policy if exists "notificacoes proprias excluidas" on public.flow_notifications;

create policy "notificacoes proprias"
on public.flow_notifications
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "notificacoes marcadas como lidas"
on public.flow_notifications
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "notificacoes proprias excluidas"
on public.flow_notifications
for delete
to authenticated
using ((select auth.uid()) = user_id);

-- O papel anônimo não precisa alcançar esta tabela. Para usuários autenticados,
-- só ficam os três privilégios realmente usados pela central.
revoke all privileges on table public.flow_notifications from anon;
revoke insert, truncate, references, trigger on table public.flow_notifications from authenticated;
grant select, update, delete on table public.flow_notifications to authenticated;

comment on policy "notificacoes proprias excluidas" on public.flow_notifications is
  'Permite que o destinatário exclua somente as próprias notificações.';
