# Nova base Supabase — uso futuro

Este diretório não contém nenhuma migração do GRCON principal. O arquivo `schema.sql` cria um banco novo, exclusivo para a Operação de Solicitações, usando objetos `sol_*`.

Para ativar no futuro:

1. Crie um projeto Supabase novo, em outro projeto/conta conforme necessário.
2. Execute `database/schema.sql` nesse projeto novo.
3. Crie os usuários no Supabase Auth.
4. Insira cada usuário em `sol_members`, usando o mesmo `workspace_id` configurado no app e um dos papéis: `owner`, `admin`, `operator` ou `viewer`.
5. Configure as variáveis `GRCON_STORAGE_DRIVER=supabase`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` e `GRCON_WORKSPACE_ID`.
6. Gere `runtime-config.js` com `npm run build` e publique.

Nenhuma URL ou chave do banco anterior é necessária ou aceita pelo código do novo aplicativo.
