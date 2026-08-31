-- GRCON Flow — índice da auditoria da entrada externa.
--
-- O FK para auth.users precisa de índice próprio para que exclusão/manutenção
-- de uma conta não percorra toda a fila de mensagens.

begin;

create index if not exists flow_external_inbox_reviewed_by_idx
  on public.flow_external_inbox (reviewed_by)
  where reviewed_by is not null;

commit;
