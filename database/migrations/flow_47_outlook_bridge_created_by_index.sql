-- GRCON Flow — apoio à manutenção da conta que ativou uma ponte.
--
-- A FK criada na flow_46 usa ON DELETE SET NULL. O índice evita percorrer toda
-- a tabela de pontes quando uma conta administrativa for removida.

begin;

create index if not exists flow_external_webhook_secrets_created_by_idx
  on public.flow_external_webhook_secrets (created_by)
  where created_by is not null;

commit;
