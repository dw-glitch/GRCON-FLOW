# GRCON Flow

Central de recebimento, triagem, execução, acompanhamento e conclusão de
solicitações documentais.

O princípio que organiza o aplicativo inteiro:

> **O solicitante informa apenas o que ele sabe. O GRCON Flow entende o tipo de
> pedido e conduz o resto do processo.**

O Flow nasceu do módulo "Operação de Solicitações" do GRCON, mas é um
aplicativo independente: banco, usuários, permissões, histórico e publicação
próprios. Nenhuma tabela, chave ou URL do GRCON principal é usada.

---

## Como funciona

```
Solicitante → escolhe o serviço → formulário se adapta → envia
     ↓
Solicitação REGISTRADA SEMPRE + protocolo FLOW-AAAA-NNNNNN
     ↓
Triagem automática (quando o tipo usa LD e há código)
     ↓
Painel operacional, com colunas do tipo do pedido
     ↓
Responsável → execução → validação → conclusão
     ↓
Histórico completo · Exportação do Controle de Solicitações
```

### Três rotas

| Rota | Para quem | O que faz |
| --- | --- | --- |
| `/solicitar` | qualquer usuário | Escolhe o serviço e registra o pedido. Formulário muda por tipo. |
| `/acompanhar` | quem solicitou | Consulta pelo protocolo e lista os próprios pedidos. |
| `/painel` | equipe de qualidade | Dashboard, triagem, distribuição, Base de LDs, tipos, usuários e acesso. |

A raiz `/` não é uma tela: é um roteador. Quem solicita cai no formulário, a
equipe cai no painel — cada um já abre no seu lugar.

O solicitante não alcança o painel — nem pela tela, nem pela API: a RLS do
banco recusa.

---

## As regras que não se negociam

**Código de documento não é obrigatório.** O pedido pode chegar com o código,
só com o título, com uma TAG, com uma descrição, com uma pergunta ou apenas com
um arquivo. Cada tipo decide o que exige.

**A solicitação é registrada sempre.** O resultado da triagem descreve o que foi
encontrado; nunca impede o registro. Documento inexistente, LD indisponível,
divergência entre bases — tudo isso vira informação no painel, não recusa no
formulário.

**Nada é inventado.** Sem alocação na LD, o campo fica vazio e a tela diz "SEM
ALOCAÇÃO IDENTIFICADA". Documento fora das bases vira "NÃO LOCALIZADO NAS LDS
ATIVAS". Um título nunca vira código sozinho: o Flow oferece candidatos e o
operador confirma.

**Divergência vai para validação.** Quando as LDs vigentes discordam sobre
revisão, título ou alocação do mesmo documento, nenhuma ocorrência é eleita —
a divergência é mostrada para alguém decidir.

**Reprocessar não apaga.** Cada triagem é uma execução nova, registrada com a
versão de LD que usou. A análise anterior permanece.

### Classificações

| Classificação | Quando |
| --- | --- |
| `PRONTO` | Localizado, sem conflito, com alocação. |
| `VALIDAR` | Encontrado em registros que divergem entre si. |
| `ACAO_NECESSARIA` | Localizado, porém sem alocação identificada. |
| `NAO_LOCALIZADO` | Não consta nas LDs vigentes. |
| `IDENTIFICACAO_PENDENTE` | Chegou sem código e sem correspondência. |
| `POSSIVEIS_CORRESPONDENCIAS` | Candidatos encontrados pelo título. |
| `TRIAGEM_NAO_APLICAVEL` | O tipo não depende de consulta documental. |

Para tipos como "Inclusão na LD", não achar o documento é o esperado — o painel
mostra isso em tom neutro, não como alerta.

---

## Tipos de solicitação são dados, não código

Rótulo, descrição, prazo, prioridade, fluxo, colunas do painel, campos do
formulário e comportamento da triagem ficam no banco e são editáveis em
**Painel → Tipos de solicitação**. Criar um serviço novo não exige publicar o
aplicativo.

Cada tipo controla:

- `uses_ld` — consulta as LDs vigentes;
- `requires_document` / `allows_documents` — se exige e se aceita códigos;
- `title_search` — procura candidatos pelo título quando não há código;
- `not_found_is_expected` — não achar é normal para este pedido;
- `answer_required` — encerra com uma resposta escrita;
- `panel_columns` — o que o painel destaca para este tipo;
- `workflow` — os status por onde o pedido passa.

Já vêm cadastrados 11 tipos, entre eles Postagem no SIGEM, Alocação, Inclusão
na LD, Alteração de título, Correção de alocação, Impressão, **Localizar código
pelo título** e **Consulta / Solicitação de informação**.

---

## Base Documental

As LDs vivem dentro do Flow — o solicitante nunca anexa uma.

Em **Painel → Base de LDs**, o administrador cadastra a LD (LD_001, LD_004, LD
de Comissionamento…) e publica a revisão vigente. O aplicativo lê a planilha com
o motor documental do GRCON (`core.js`), que reconhece cabeçalho em qualquer
linha, abas vigentes e colunas com nomes diferentes; indexa os documentos no
Postgres; e ativa a nova versão.

A revisão anterior fica **inativa, não apagada**, e cada triagem registra qual
versão usou. Atualizar todo dia é um upload e um clique.

---

## Excel é saída, não banco

**Painel → Exportar Excel** gera duas abas:

1. **Controle de Solicitações** — as 26 colunas na ordem e com a grafia da
   planilha oficial, para colar sob o que já existe. Campo não apurado sai como
   `na`, a convenção da própria planilha.
2. **Detalhe do Flow** — protocolo, tipo, classificação da triagem, LD
   consultada, versão, responsável, resposta e prazos.

Filtros por tipo, status, responsável, solicitante, período, classificação ou
apenas os itens selecionados.

---

## Perfis

| Perfil | Alcance |
| --- | --- |
| **Solicitante** | Cria e acompanha o que é dele. |
| **Operador** | Recebe, tria, executa e atualiza solicitações. |
| **Administrador** | Tudo do operador + tipos, LDs, responsáveis e usuários. |
| **Proprietário** | Controle total, inclusive promover outro proprietário. |

### Quem pode entrar

Duas travas independentes, ambas em **Painel → Acesso**:

- **Domínios autorizados** — só e-mails desses domínios conseguem criar conta, e
  entram como **solicitante**. Já vem com `agnet.com.br`. Lista vazia = cadastro
  aberto a qualquer e-mail, e a tela avisa disso em destaque.
- **Lista da equipe** — e-mails que entram direto como **operador** (ou o papel
  que você escolher). A lista **passa por cima do domínio**, o que permite dar
  acesso a um consultor de fora sem abrir a empresa inteira.

Acrescentar à lista alguém que já tem conta **promove na hora** — não é preciso
recriar o cadastro. Tirar da lista impede um cadastro novo com aquele papel, mas
**não rebaixa** quem já entrou; rebaixar é ato explícito, em Painel → Usuários.

Promover ou rebaixar em Usuários mantém a lista em dia automaticamente, para as
duas telas nunca discordarem.

O **primeiro** usuário do sistema vira **proprietário** automaticamente — sem
isso não haveria como administrar o aplicativo recém-publicado.

As permissões são aplicadas na tela **e** no banco (RLS + funções que conferem o
papel). A tela só evita mostrar o que geraria erro; quem recusa de verdade é o
Postgres.

---

## Primeiro acesso

### Antes de tudo: dois ajustes no painel do Supabase

Nenhum dos dois se resolve por código, e **sem o primeiro ninguém consegue
entrar**.

1. **Confirmação de e-mail.** O projeto usa o SMTP padrão do Supabase, que só
   entrega para membros do projeto e é fortemente limitado — um colega que se
   cadastre não recebe o e-mail e fica de fora. Em *Authentication → Providers →
   Email*, desmarque **Confirm email**; ou configure o SMTP da empresa em
   *Authentication → Emails → SMTP Settings*, que é o certo a médio prazo.

2. **Hook de cadastro.** Em *Authentication → Hooks*, ative **Before User
   Created** apontando para `public.flow_antes_de_criar_usuario`. É o que faz a
   recusa por domínio chegar como uma frase legível. Sem o hook o cadastro
   **continua sendo barrado** — só que a pessoa vê `Database error saving new
   user` em vez do motivo.

### Depois

1. Abra a aplicação e **crie sua conta** — o primeiro cadastro vira proprietário.
2. **Painel → Acesso** — confira os domínios e cadastre os e-mails da equipe de
   qualidade.
3. **Painel → Base de LDs** — cadastre suas LDs e publique a revisão vigente de
   cada uma.
4. **Painel → Tipos de solicitação** — ajuste rótulos, prazos e campos.
5. Divulgue o link. Quem for da empresa se cadastra e já cai no formulário;
   quem estiver na lista da equipe cai no painel.

Sem LD publicada o aplicativo funciona: as solicitações são registradas e ficam
como "não localizado" ou "identificação pendente" até a base entrar.

---

## Desenvolvimento

```bash
npm run build     # gera flow_config.js
npm run dev       # sobe em http://localhost:4173 (reproduz o cleanUrls da Vercel)
npm run verify    # build + sintaxe + testes
```

Aplicação estática: HTML, CSS e JavaScript sem framework nem etapa de bundling.
As bibliotecas (SheetJS, ExcelJS, supabase-js) acompanham o repositório, então
não há dependência de CDN em runtime.

### Arquivos

| Arquivo | Papel |
| --- | --- |
| `flow_api.js` | Toda a conversa com o banco. As telas não montam consulta. |
| `flow_docs.js` | Normalização de código, leitura de LD, extração de arquivos. |
| `flow_ui.js` | Barra do topo, guarda de rota, selos, avisos, formatação. |
| `flow_solicitar.js` | Portal do solicitante e formulário dinâmico. |
| `flow_painel.js` | Painel, ficha, itens, triagem, comentários, histórico. |
| `flow_ld.js` | Base Documental: upload, indexação e versionamento. |
| `flow_admin.js` | Tipos, campos e usuários. |
| `flow_export.js` | Geração do Excel. |
| `core.js`, `requests_core.js`, `requests_report.js`, `grcon_contracts.js` | Motor documental e planilhas, preservados do GRCON. |

### Variáveis de ambiente

Opcionais — o `npm run build` já aponta para o projeto Supabase do GRCON Flow.

| Variável | Para quê |
| --- | --- |
| `FLOW_SUPABASE_URL` | Apontar para outro projeto (homologação, por exemplo). |
| `FLOW_SUPABASE_ANON_KEY` | A chave **publicável** do projeto. |
| `FLOW_UPLOAD_MAX_MB` | Tamanho máximo de anexo (padrão 25). |
| `FLOW_LD_UPLOAD_MAX_MB` | Tamanho máximo do arquivo de LD (padrão 100). |

A URL e a chave publicável são feitas para viajar no navegador; o que protege os
dados é a RLS. A `service_role` **nunca** entra aqui — o build recusa se ela for
informada.

---

## Banco

Documentação do schema, dos papéis, das políticas e das funções em
[`database/README.md`](database/README.md).
