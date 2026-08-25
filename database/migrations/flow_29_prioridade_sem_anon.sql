-- ---------------------------------------------------------------------------
-- flow_29 — tira `anon` da lista de execução de flow_set_request_priority.
--
-- A flow_28 criou a função com `revoke all ... from public` seguido de
-- `grant execute ... to authenticated`. Faltou uma coisa: o Supabase concede
-- execute a anon, authenticated e service_role por ALTER DEFAULT PRIVILEGES no
-- momento em que a função nasce, e `revoke from public` não alcança concessão
-- nominal a papel. Resultado: das 57 funções flow_* do banco, esta ficou sendo
-- a única com anon na ACL.
--
-- Não havia porta aberta: a função barra quem não tem sessão logo na primeira
-- linha (`auth.uid() is null`), então a chave anônima só recebia o erro. O que
-- se corrige aqui é a inconsistência — uma ACL que destoa das outras 56 é
-- exatamente o tipo de coisa que vira brecha de verdade quando alguém mexer no
-- corpo da função daqui a um ano e confiar na lista de permissões.
--
-- Idempotente: revogar o que já não existe não dá erro.
-- ---------------------------------------------------------------------------

revoke execute on function public.flow_set_request_priority(uuid, text, text) from anon;
