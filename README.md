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
     └── pode anexar PDF, Excel, Word e DWG
     ↓
Solicitação REGISTRADA SEMPRE + protocolo FLOW-AAAA-NNNNNN
     ↓
Triagem automática (por código ou por título, quando possível)
     ↓
Painel operacional, com colunas do tipo do pedido
     ↓
Postagem no SIGEM: identificar código → incluir na LD → alocar → postar
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

No painel, a equipe da Qualidade também tem o **Registro rápido** para lançar
pedidos recebidos por Teams, Outlook, telefone ou conversa. A Fase 2 organiza
uma mensagem colada, sugere solicitante, contato, área, tipo e documentos, mas
nunca registra sem revisão.

### Outlook clássico + Power Automate + OneDrive

A aba **Importar do Outlook** recebe, sem conector Premium e sem programa local,
os e-mails que a equipe move deliberadamente para a pasta **GRCON FLOW** da
caixa corporativa. Um fluxo agendado do Power Automate copia metadados e anexos para
uma fila sincronizada pelo OneDrive e move a mensagem para **Processados**. O
GRCON Flow lê essa pasta somente depois de a pessoa autorizá-la no navegador.

O registro continua assistido: remetente, tipo, pedido, documentos e anexos são
mostrados para revisão. Ao confirmar, a mesma RPC protegida do Registro rápido
cria o protocolo, envia os arquivos e executa a triagem nas LDs. A chave
derivada do identificador do e-mail torna a repetição idempotente, e o arquivo
`<ID>__importado.json` gravado na fila guarda o protocolo e permite retomar anexos
sem duplicar o pedido.

O contrato e a montagem do fluxo estão em [`power-automate/README.md`](power-automate/README.md).

**Responsável é uma pessoa, não um nome digitado.** A ficha sugere os nomes da
equipe ativa, e o banco resolve o nome escolhido em `owner_profile_id`, com
chave estrangeira de verdade — é o que permite avisar quem executa. O campo
continua aceitando texto livre, porque o responsável pode ser alguém sem conta
no aplicativo; nesse caso a tela avisa, na hora, que **essa pessoa não receberá
aviso**, em vez de deixar a diferença invisível. Nome que bate com duas pessoas
da equipe não é resolvido: adivinhar qual delas seria pior do que admitir que
não dá para saber.

**Aviso é para quem executa, não para quem pede.** Por decisão do cliente, o
solicitante não recebe notificação: ele acompanha o pedido em `/acompanhar`,
pelo protocolo. Quem é avisado é a equipe de qualidade — quem de fato executa a
atividade. O registro de uma nova solicitação notifica todo perfil ativo com
papel de operador, administrador ou proprietário, e a caixa de entrada do painel
é a fonte da verdade desses avisos.

A lista do painel é paginada no servidor: 25, 50, 100 ou 200 por página, com o
total do recorte e a posição sempre à vista. Todo filtro — inclusive "atrasadas",
"sem responsável" e os recortes por classificação — é aplicado no banco, e não
sobre as linhas já carregadas: numa página de 50, peneirar depois responderia
sobre as 50 primeiras em vez de sobre a base inteira.

Há filtro por prioridade e um cartão de urgentes em aberto, e a coluna
**Prioridade** fica logo depois do protocolo, porque é o que mais muda a ordem de
leitura da linha.

A coluna **Origem** responde a bifurcação central do controle em papel — NOVO ou
JÁ PREVISTO — e tem filtro próprio. Ela não é digitada por ninguém: sai da
triagem, que já grava em cada item se o documento consta nas LDs vigentes, e o
banco resume isso por solicitação a cada mudança de item.

Clicar no cabeçalho ordena, também no banco, e volta para a primeira página. O
mesmo clique repetido inverte o sentido; trocar de coluna começa pelo sentido
natural daquele dado — data pela mais recente, texto em A–Z. **Progresso** não
ordena de propósito: "2 de 2" e "2 de 10" não se comparam por um número só, e
oferecer a ordem errada é pior do que não oferecer nenhuma.

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

**Urgência é ato explícito, e escasso.** O solicitante pode marcar o pedido como
urgente no formulário, e a equipe pode subir ou baixar a prioridade na ficha. A
marcação entra no histórico com autor e horário — não é parâmetro silencioso do
registro —, destaca a linha no painel com faixa e selo, alimenta o cartão
"Urgentes em aberto" e sai por extenso na planilha. **Normal não ganha selo**: se
toda linha se destaca, nenhuma se destaca. Urgência de pedido concluído deixa de
aparecer, porque não é mais fila de trabalho.

**Divergência vai para validação.** Quando as LDs vigentes discordam sobre
revisão, título ou alocação do mesmo documento, nenhuma ocorrência é eleita —
a divergência é mostrada para alguém decidir.

**Reprocessar não apaga.** Cada triagem é uma execução nova, registrada com a
versão de LD que usou. A análise anterior permanece.

**Anexos ficam privados.** Todo tipo de solicitação aceita até 30 arquivos em
PDF, Excel (`.xls`, `.xlsx`, `.xlsm`), Word (`.doc`, `.docx`), DWG e imagem
(`.jpg`, `.jpeg`, `.png`, `.webp`, `.heic`, `.heif`), com até **50 MB por
arquivo e 150 MB na soma de uma solicitação**. Arquivos acima de 6 MB usam
envio retomável, que continua do ponto recebido quando a conexão oscila. O
solicitante vê o progresso e pode tentar novamente se algum falhar. A equipe
baixa o original na ficha por um link temporário; o bucket não é público.

**Foto grande é reduzida, não recusada.** Quando uma imagem passa do limite, o
navegador a redimensiona para 2200 px no maior lado e reenvia como JPEG. A
redução é **último recurso antes da recusa**, nunca o caminho normal: abaixo do
limite o arquivo original sobe intacto, porque o `canvas` descarta o EXIF — data,
orientação e coordenada da foto —, e numa evidência de campo esses metadados
podem valer tanto quanto a imagem. Documento grande continua recusado: não há
como reduzir um PDF sem perder conteúdo.

**Imagem não entra no conjunto obrigatório da N-1710.** LI/MC exige PDF *e*
Excel do mesmo documento, e a regra é do contrato. Uma foto anexada a um item
LI/MC é recusada com a explicação; em qualquer outro item ela entra como anexo
complementar e conta no teto de 30.

**Exclusão é administrativa e permanente.** Administrador e proprietário podem
excluir uma solicitação pela ficha do painel. Uma caixa única mostra o que vai
sumir e só libera o botão quando o protocolo é digitado; então o aplicativo
remove os anexos pelo Storage API e só depois apaga a solicitação, seus itens,
triagens, histórico e comentários.

Toda pergunta do aplicativo é da própria tela — nenhuma sai pelo `confirm` do
navegador, que trava a aba, ignora o tema, não cabe em tela pequena e não sabe
dizer o que está sendo apagado. A caixa devolve o foco de onde veio, prende o
Tab e, quando não há nada a digitar, começa com o cursor em "Cancelar".

### Origem: NOVO × JÁ PREVISTO

A folha de controle separava a demanda em dois caminhos depois da triagem. O
aplicativo responde sozinho, e com duas respostas a mais — que são justamente as
que dão trabalho:

| Origem | Quando |
| --- | --- |
| `novo` | Nenhum documento do pedido consta nas LDs vigentes. |
| `previsto` | Todos já constam. O status vem do SIGEM. |
| `misto` | O pedido tem documento novo **e** documento já previsto. |
| `a_confirmar` | Algum documento ainda está sem código confirmado. |
| `nao_aplicavel` | Tipo de serviço que não consulta LD. |

`a_confirmar` tem precedência sobre os demais de propósito: enquanto um item do
pedido não tem código confirmado, ele pode virar qualquer um dos dois caminhos.
Dizer "JÁ PREVISTO" porque os outros dois já existem esconderia exatamente o
documento que ainda dá trabalho. Por isso também o primeiro clique na coluna
traz `a_confirmar` ao topo.

As cores são as que o cliente desenhou: verde para novo, azul para já previsto.
Como na urgência, a cor é reforço — a palavra está escrita no selo e vai por
extenso para a planilha.

### Família normativa: N-1710 / ET / CV

Qual norma rege o código do documento — a pergunta que o controle em papel
chama de "identificação do tipo". Não é o tipo do documento (RIR, PR, RL, CE,
MC), que a LD já traz: é qual regra de codificação vale, porque é ela que define
o que precisa ser entregue.

| Família | Quando |
| --- | --- |
| `ET` | Relatório sob a especificação técnica do contrato (código com `_RNEST_`). |
| `CV` | Currículo, pelos cinco grupos previstos na ET. |
| `N-1710` | O caso geral: codificação de documentos de engenharia da Petrobras. |
| vazio | Item que chegou só com título — não há código para reger. |

Ninguém digita: `flow_document_family` responde a partir do código, e o mesmo
gatilho que já preparava o item grava a resposta. A regra existe em dois
lugares — `core.js` valida a codificação na importação da LD, o SQL responde no
banco, que é quem escreve o item — e há teste que lê os dois e falha se saírem
de sincronia. É o mesmo arranjo de `flow_is_n1710_li_mc`.

A família **não tem cor própria**, de propósito. O código de cores do controle
em papel tem três entradas — azul para já previsto, verde para novo, vermelho
para urgente —, todas em uso. Uma quarta paleta competiria com as que já
carregam significado; a sigla em selo neutro resolve.

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

Quando a LD afirma que o documento está alocado mas não informa o código da
GRDT, a tela diz **"alocada, código não informado na LD"** — nem inventa um
código, nem afirma que não há alocação. As três respostas possíveis da LD
(código, alocação sem código, sem alocação) são ditas como três, não como duas.

Na **Postagem no SIGEM**, o solicitante não precisa conhecer as etapas internas.
Ele informa um ou vários títulos e, quando souber, os códigos. O painel decide a
próxima ação de cada item: identificar código, incluir na LD, alocar ou postar.

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

A **Postagem no SIGEM** é o serviço único para o fluxo de inclusão/alocação/postagem:
"Alocação", "Inclusão na LD" e "Inclusão na LD + Alocação" permanecem no histórico
do banco, porém inativos para novos pedidos. Outros serviços específicos, como
Alteração de título, Correção de alocação, Impressão, **Localizar código pelo
título** e **Consulta / Solicitação de informação**, continuam disponíveis.

---

## Base Documental

As LDs vivem dentro do Flow — o solicitante nunca anexa uma.

Em **Painel → Base de LDs**, o administrador cadastra a LD (LD_001, LD_004, LD
de Comissionamento…) e publica a revisão vigente. O aplicativo lê a planilha com
o motor documental do GRCON (`core.js`), que reconhece cabeçalho em qualquer
linha, abas vigentes e colunas com nomes diferentes; indexa os documentos no
Postgres; e ativa a nova versão.

A publicação começa por uma **pré-análise**: `Colar SIGEM` é preservada como
histórico, mas nunca entra no índice vigente; abas técnicas ocultas exigem
seleção manual; duplicatas idênticas são consolidadas; e linhas divergentes
bloqueiam a ativação até o administrador assumir uma regra de resolução. O
arquivo original, o hash, as abas escolhidas, os alertas e essa decisão ficam no
relatório da versão.

A revisão anterior fica **inativa, não apagada**, e cada triagem registra qual
versão usou.

Em **Painel → Normas e códigos**, o proprietário mantém normas, revisões e os
catálogos usados na validação. Uma nova revisão nasce como rascunho e só passa a
reger as próximas LDs quando for ativada explicitamente; a anterior continua no
histórico. Revisões pré-cadastradas aceitam o vínculo posterior do PDF sem criar
duplicidade, e o arquivo controlado pode ser aberto pelo painel. Na N-1710, o
texto principal e os anexos A–G aparecem separadamente porque cada parte possui
seu próprio ciclo de revisão.

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

**Exportar painel** leva o recorte inteiro, não a página que está na tela: se o
filtro tem 312 solicitações e a tabela mostra 50, o arquivo sai com as 312. A
seleção também atravessa páginas — marcar três na primeira e duas na quarta
exporta cinco.

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
  entram como **solicitante**. Já vem com `agnet.com.br`. Lista vazia mantém o
  cadastro de solicitantes fechado.
- **Lista da equipe** — e-mails que entram direto como **operador** (ou o papel
  que você escolher). A lista **passa por cima do domínio**, o que permite dar
  acesso a um consultor de fora sem abrir a empresa inteira.

Acrescentar à lista alguém que já tem conta **promove na hora** — não é preciso
recriar o cadastro. Tirar da lista impede um cadastro novo com aquele papel, mas
**não rebaixa** quem já entrou; rebaixar é ato explícito, em Painel → Usuários.

Promover ou rebaixar em Usuários mantém a lista em dia automaticamente, para as
duas telas nunca discordarem.

**Cada um cuida do próprio cadastro.** O nome no alto da tela abre **Meu
perfil**, onde a pessoa corrige nome, área e contato — os mesmos campos que o
formulário de solicitação já traz preenchidos — e troca a senha sem passar pelo
"esqueci minha senha". Quem usa o link de recuperação por e-mail cai numa tela
que pede a nova senha antes de seguir; e-mail e papel continuam sendo do
administrador.

O primeiro proprietário não é mais escolhido por corrida de cadastro. Antes de
abrir o aplicativo, seu e-mail precisa ser preparado uma única vez no bootstrap
seguro; somente esse endereço poderá criar a conta proprietária inicial.

As permissões são aplicadas na tela **e** no banco (RLS + funções que conferem o
papel). A tela só evita mostrar o que geraria erro; quem recusa de verdade é o
Postgres.

---

## Primeiro acesso

### Antes de tudo: três ajustes no painel do Supabase

Nenhum dos dois se resolve por código, e **sem o primeiro ninguém consegue
entrar**.

1. **Proprietário inicial.** No SQL Editor, com acesso administrativo, execute
   `select public.flow_prepare_owner_bootstrap('seu-email@empresa.com');`. O
   cadastro fica fechado até esse e-mail ser preparado.

2. **Confirmação de e-mail.** O projeto usa o SMTP padrão do Supabase, que só
   entrega para membros do projeto e é fortemente limitado — um colega que se
   cadastre não recebe o e-mail e fica de fora. Em *Authentication → Providers →
   Email*, desmarque **Confirm email**; ou configure o SMTP da empresa em
   *Authentication → Emails → SMTP Settings*, que é o certo a médio prazo.

3. **Hook de cadastro.** Em *Authentication → Hooks*, ative **Before User
   Created** apontando para `public.flow_antes_de_criar_usuario`. É o que faz a
   recusa por domínio chegar como uma frase legível. Sem o hook o cadastro
   **continua sendo barrado** — só que a pessoa vê `Database error saving new
   user` em vez do motivo.

### Depois

1. Abra a aplicação e crie a conta com o e-mail preparado — ela nasce como proprietária.
2. **Painel → Acesso** — confira os domínios e cadastre os e-mails da equipe de
   qualidade.
3. **Painel → Base de LDs** — cadastre suas LDs e publique a revisão vigente de
   cada uma.
4. **Painel → Normas e códigos** — confira as revisões vigentes e os catálogos.
5. **Painel → Tipos de solicitação** — ajuste rótulos, prazos e campos.
6. Divulgue o link. Quem for da empresa se cadastra e já cai no formulário;
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
| `flow_ui.js` | Barra do topo, guarda de rota, selos, avisos, formatação, modal e perfil. |
| `flow_solicitar.js` | Portal do solicitante e formulário dinâmico. |
| `flow_painel.js` | Painel, ficha, itens, triagem, comentários, histórico. |
| `flow_ld.js` | Base Documental: upload, indexação e versionamento. |
| `flow_admin.js` | Tipos, campos e usuários. |
| `flow_export.js` | Geração do Excel. |
| `core.js`, `requests_core.js`, `requests_report.js`, `grcon_contracts.js` | Motor documental e planilhas, preservados do GRCON. |

### Variáveis de ambiente

Opcionais — o `npm run build` já aponta para o projeto Supabase do GRCON Flow.
Variáveis genéricas `SUPABASE_URL`/`SUPABASE_ANON_KEY` não são lidas: somente
variáveis prefixadas com `FLOW_` podem trocar o projeto, evitando herança acidental
da configuração do GRCON principal na hospedagem.

| Variável | Para quê |
| --- | --- |
| `FLOW_SUPABASE_URL` | Apontar para outro projeto (homologação, por exemplo). |
| `FLOW_SUPABASE_ANON_KEY` | A chave **publicável** do projeto. |
| `FLOW_UPLOAD_MAX_MB` | Tamanho máximo de cada anexo (padrão 50). Imagem acima disso é reduzida no navegador em vez de recusada. |
| `FLOW_UPLOAD_MAX_FILES` | Quantidade máxima de anexos por solicitação (padrão 30, o mesmo teto do banco). |
| `FLOW_UPLOAD_MAX_REQUEST_MB` | Soma máxima dos anexos de uma solicitação (padrão 150). |
| `FLOW_STORAGE_QUOTA_MB` | Cota usada pela barra do painel (padrão 1024 MB no plano Free). |
| `FLOW_LD_UPLOAD_MAX_MB` | Tamanho máximo do arquivo de LD (padrão 100). |

A URL e a chave publicável são feitas para viajar no navegador; o que protege os
dados é a RLS. A `service_role` **nunca** entra aqui — o build recusa se ela for
informada.

---

## Banco

Documentação do schema, dos papéis, das políticas e das funções em
[`database/README.md`](database/README.md).
