-- GRCON Flow 52 — remove do banco o que sobrou da Fase 3.
-- Aplicada no projeto em 20260902220503.
--
-- ATENÇÃO: esta é a única migração destrutiva do projeto. Leia o cabeçalho
-- inteiro e rode as conferências antes de aplicar. O desfazimento está em
-- `flow_52_rollback_da_fase_3.sql`, no mesmo diretório.
--
-- O QUE SAI
--   tabelas   flow_external_inbox, flow_external_webhook_secrets
--   funções   flow_convert_external_inbox, flow_discard_external_inbox,
--             flow_redact_external_inbox_batch, flow_register_outlook_bridge,
--             flow_list_outlook_bridges, flow_revoke_outlook_bridge
--
-- POR QUE NÃO SÃO MAIS USADOS
--   São a caixa de entrada externa por webhook e a ponte local em PowerShell.
--   As duas foram descartadas pela política corporativa — o script não tinha
--   assinatura digital — e substituídas pelo caminho Outlook → Power Automate →
--   OneDrive → navegador. Os arquivos correspondentes já saíram do repositório
--   (migrações 43, 44, 46-bridge e 47, `flow_entradas.js`, a edge function e a
--   pasta `ponte-outlook/`). Nenhuma linha do frontend chama qualquer um destes
--   objetos: a varredura por `external_inbox` e `outlook_bridge` em `*.js` não
--   devolve ocorrência.
--
-- CONFERIR ANTES DE APLICAR
--   1. As duas tabelas precisam estar vazias:
--        select count(*) from public.flow_external_inbox;
--        select count(*) from public.flow_external_webhook_secrets;
--      Se houver linha, PARE: é dado de e-mail que precisa ser exportado ou
--      descartado com decisão de quem responde pela retenção.
--   2. Nenhum outro objeto pode depender delas:
--        select p.proname from pg_proc p
--          join pg_namespace n on n.oid = p.pronamespace
--         where n.nspname = 'public'
--           and pg_get_functiondef(p.oid) ~* 'external_inbox|external_webhook_secrets|outlook_bridge';
--      O resultado deve conter apenas as seis funções listadas acima.
--   3. Nenhuma solicitação pode apontar para a caixa antiga:
--        select count(*) from public.flow_requests where jsonb_exists(form_data, 'inbox_id');
--
-- RISCO
--   Baixo com as tabelas vazias: nada é lido, escrito ou referenciado. O risco
--   real seria remover uma função ainda citada por outra — é o que a conferência
--   2 descarta. A migração roda numa transação só: ou tudo sai, ou nada sai.
--
-- TESTES DEPOIS
--   Registrar uma solicitação pelo formulário e outra pela importação do
--   Outlook; exportar o Excel; rodar `npm run verify`; conferir nos advisors que
--   os avisos correspondentes sumiram e que `rls_enabled_no_policy` caiu de três
--   para dois.
--
-- O histórico de migrações NÃO deve ser tocado: as entradas 43, 44,
-- `flow_46_outlook_local_bridge` e 47 permanecem em
-- `supabase_migrations.schema_migrations` como registro de que isso existiu.

begin;

do $$
declare
  entradas integer;
  segredos integer;
  vinculos integer;
begin
  select count(*) into entradas from public.flow_external_inbox;
  select count(*) into segredos from public.flow_external_webhook_secrets;
  select count(*) into vinculos from public.flow_requests where jsonb_exists(form_data, 'inbox_id');

  if entradas > 0 or segredos > 0 then
    raise exception
      'A limpeza foi interrompida: flow_external_inbox tem % linha(s) e flow_external_webhook_secrets tem % linha(s). Trate os dados antes de remover as tabelas.',
      entradas, segredos;
  end if;
  if vinculos > 0 then
    raise exception
      'A limpeza foi interrompida: % solicitação(ões) ainda referenciam a caixa externa em form_data.', vinculos;
  end if;
end $$;

drop function if exists public.flow_convert_external_inbox(uuid, text, text, text, text, text, text, jsonb, jsonb);
drop function if exists public.flow_discard_external_inbox(uuid, text);
drop function if exists public.flow_redact_external_inbox_batch(timestamptz, integer);
drop function if exists public.flow_register_outlook_bridge(uuid, text, text, text);
drop function if exists public.flow_list_outlook_bridges();
drop function if exists public.flow_revoke_outlook_bridge(uuid);

drop table if exists public.flow_external_inbox;
drop table if exists public.flow_external_webhook_secrets;

commit;
