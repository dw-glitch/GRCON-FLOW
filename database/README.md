# Banco do GRCON Flow

Projeto Supabase **exclusivo** do GRCON Flow. Nenhum objeto, chave ou dado do
Supabase do GRCON principal é usado — os dois sistemas não compartilham base.

As migrações estão aplicadas e versionadas no próprio projeto Supabase
(`supabase_migrations.schema_migrations`), na ordem abaixo.

| Migração | O que cria |
| --- | --- |
| `flow_01_profiles_and_roles` | Perfis, os quatro papéis, gatilho do Auth, troca de papel |
| `flow_02_request_types_and_fields` | Tipos de solicitação e seus campos dinâmicos |
| `flow_03_requests_items_history` | Solicitações, itens, triagens, histórico, comentários, anexos, notificações, protocolo |
| `flow_04_rls_requests` | Políticas de isolamento entre solicitante e equipe |
| `flow_05_ld_base` | Base Documental: LDs, versões, documentos indexados, ingestão |
| `flow_06_triage_engine` | Registro da solicitação e motor de triagem |
| `flow_07_operations_and_storage` | Operações do painel, view de exportação, buckets |
| `flow_08_seed_types` | Os 11 tipos iniciais e seus campos |
| `flow_09_hardening` | RLS no contador, extensões fora do `public`, revogação do acesso anônimo |
| `flow_10_acesso` | Domínios autorizados, lista de e-mails da equipe, hook de cadastro |
| `flow_11_espelho_allowlist` | Mantém a lista de acesso coerente com os papéis |
| `flow_12_safe_ld_import` | Pré-análise auditável, hash, unicidade, finalização e ativação segura das LDs |
| `flow_13_versioned_norms` | Normas, revisões, catálogos versionados e bucket de PDFs controlados |
| `flow_14_secure_owner_and_permissions` | Bootstrap por e-mail, perfis sem autoelevação e notificações da equipe |
| `flow_15_seed_norm_versions` | Garante as revisões normativas iniciais em projetos já migrados |
| `flow_16_norm_sources_and_files` | Corrige metadados, separa os anexos A–G da N-1710 e permite anexar PDFs às revisões iniciais |
| `flow_17_request_attachments` | Completa os formatos de anexos do solicitante e mantém o bucket privado em 25 MB |

## Tabelas

| Tabela | Guarda |
| --- | --- |
| `flow_profiles` | Usuário, área, papel e situação. Criado por gatilho no Auth. |
| `flow_request_types` | Tipos de solicitação e seu comportamento. |
| `flow_type_fields` | Perguntas próprias de cada tipo — o que monta o formulário. |
| `flow_requests` | A solicitação: protocolo, solicitante, status, prazo, resposta. |
| `flow_request_items` | Documento, título, pergunta ou item avulso, com status próprio. |
| `flow_triage_runs` | Cada execução de triagem, com o resultado e a versão de LD usada. |
| `flow_history` | Tudo que aconteceu, com autor, valor anterior e novo. |
| `flow_comments` | Conversa da equipe; `internal` esconde do solicitante. |
| `flow_attachments` | Arquivos da solicitação (bucket `flow-anexos`). |
| `flow_notifications` | Avisos ao solicitante. |
| `flow_lds` | As LDs cadastradas (LD_001, LD_004, Comissionamento…). |
| `flow_ld_versions` | Cada revisão publicada, ativa ou não. |
| `flow_ld_documents` | Documentos indexados de cada versão. É a base das consultas. |
| `flow_settings` | Configurações gerais, inclusive os domínios autorizados. |
| `flow_access_allowlist` | E-mails da equipe e o papel de cada um. Admin-only. |
| `flow_protocol_counters` | Numeração do protocolo. Sem policy: só a função a alcança. |
| `flow_norms` / `flow_norm_versions` | Norma e histórico de revisões, com uma vigente por código. Texto e anexos da N-1710 têm controle independente. |
| `flow_norm_catalog_entries` | Histórico append-only dos códigos usados na validação das LDs. |
| `flow_owner_bootstrap` | E-mail único autorizado a criar o primeiro proprietário. Não é exposto à API. |

Os **domínios** ficam em `flow_settings` porque o domínio de e-mail de uma
empresa não é segredo — e essa tabela é legível por qualquer autenticado. Já a
lista de **pessoas** fica em tabela própria, admin-only: essa sim revelaria quem
é da equipe.

`flow_export_view` junta solicitação e item para a exportação, com
`security_invoker` — cada um enxerga nela apenas o que já poderia ver.

## Papéis e isolamento

`solicitante` · `operador` · `administrador` · `proprietario`

O papel é lido por `flow_current_role()`, uma função `SECURITY DEFINER`: dentro
de uma policy, um `select` direto em `flow_profiles` reentraria na policy da
própria tabela.

- Solicitante enxerga **apenas as próprias solicitações**; não alcança a Base de
  LDs, os documentos indexados, os perfis alheios nem os comentários internos.
- Operador e acima enxergam a operação inteira.
- Administrador cuida de tipos, LDs e usuários.
- Só o proprietário promove outro proprietário, e o banco impede que o último
  proprietário ativo seja rebaixado.

Todas as tabelas têm RLS. Nenhuma função é executável por `anon`: sem sessão não
se alcança nem a lista de tipos.

## Funções

| Função | Para quê |
| --- | --- |
| `flow_create_request(...)` | Registra a solicitação e gera o protocolo numa operação atômica. |
| `flow_triage_request(id)` / `flow_triage_item(id)` | Executa a triagem e grava o resultado. |
| `flow_lookup_document(keys[])` | Todas as ocorrências do código nas LDs vigentes. |
| `flow_search_by_title(texto)` | Candidatos por semelhança de título (`pg_trgm`). |
| `flow_ingest_ld_documents(versao, docs)` | Grava um lote de documentos indexados. |
| `flow_activate_ld_version(versao)` | Ativa a revisão e inativa a anterior. |
| `flow_update_items(...)` / `flow_update_request(...)` | Alterações do painel, com histórico. |
| `flow_track_protocol(protocolo)` | Acompanhamento — devolve só o que o solicitante pode ver. |
| `flow_set_user_role(user, papel)` | Troca de papel, com as regras de quem pode; espelha na lista de acesso. |
| `flow_acesso_para(email)` | A regra de quem entra e com que papel. Uso interno. |
| `flow_antes_de_criar_usuario(event)` | Hook do Auth. Recusa com mensagem legível. |
| `flow_definir_acesso(email, papel)` | Autoriza um e-mail; promove na hora quem já tem conta. |
| `flow_remover_acesso(email)` | Tira da lista. **Não rebaixa** quem já entrou. |
| `flow_definir_dominios(dominios[])` | Domínios que podem criar conta. |

### Quem entra, e como

`flow_acesso_para()` é a regra, num lugar só — o hook e o gatilho a consultam, em
vez de cada um ter a sua cópia:

1. e-mail na lista → entra com o papel de lá (**passa por cima do domínio**);
2. domínio autorizado → entra como `solicitante`;
3. nenhum domínio configurado → cadastro de solicitantes fechado;
4. caso contrário → recusado.

Quando ainda não há usuário, somente o e-mail registrado por
`flow_prepare_owner_bootstrap()` pode entrar, já como `proprietario`. A decisão é
serializada e o convite é marcado como usado no mesmo cadastro.

**O hook precisa ser ativado no painel** (*Authentication → Hooks → Before User
Created*). Ele existe porque o GoTrue não propaga a mensagem de um
`raise exception` em gatilho de `auth.users`: devolveria
`Database error saving new user`. Sem o hook o cadastro continua barrado pelo
gatilho, só que sem explicar o motivo.

## Normalização dos códigos

A chave de busca (`document_key`) e a forma alternativa do `nt-` (`nt_key`) são
calculadas **no navegador**, pelo motor documental do GRCON (`TriagemCore.key` e
`documentSearchKeys`) — as mesmas funções usadas ao indexar a LD e ao registrar
a solicitação.

Isso é proposital: se cada lado normalizasse à sua maneira, um documento gravado
com uma grafia jamais seria encontrado pela outra. O banco recebe as chaves
prontas e faz o que sabe fazer melhor — acesso por índice.

## Storage

| Bucket | Conteúdo | Limite |
| --- | --- | --- |
| `flow-anexos` | Anexos das solicitações. Caminho começa pelo id da solicitação. | 25 MB |
| `flow-lds` | Arquivos originais das LDs. Área interna. | 100 MB |
| `flow-normas` | PDFs controlados das revisões normativas. Área interna. | 50 MB |

Ambos privados, com políticas que conferem quem pode ler e escrever.

## Recriar em outro projeto

Aplique as migrações na ordem da tabela acima, pelo painel do Supabase ou pelo
CLI. Depois aponte `FLOW_SUPABASE_URL` e `FLOW_SUPABASE_ANON_KEY` para o novo
projeto e rode `npm run build`. Antes do primeiro cadastro, prepare o e-mail do
proprietário com `flow_prepare_owner_bootstrap()`.
