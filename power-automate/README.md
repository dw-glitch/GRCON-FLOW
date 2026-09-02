# Power Automate — Outlook para GRCON Flow

Fluxo cloud com conectores padrão do Microsoft 365. Não usa HTTP, conector
personalizado, Microsoft Entra, gateway local, PowerShell nem licença Premium.

## Estrutura esperada

Na caixa corporativa do usuário:

```text
GRCON Flow
├── Entrada
├── Processados
└── Erros
```

No OneDrive corporativo sincronizado no computador:

```text
GRCON Flow
└── Fila
```

Como o conector padrão **OneDrive for Business** deste ambiente não oferece a
ação de criar subpasta, cada e-mail usa um prefixo único dentro de `Fila`:

```text
Fila
├── 20260901153000123-<guid>__mensagem.json
├── 20260901153000123-<guid>__anexo__false__documento.pdf
├── 20260901153000123-<guid>__anexo__false__planilha.xlsx
├── 20260901153000123-<guid>__anexo__true__logo-assinatura.png
└── 20260901153000123-<guid>__pronto.json
```

O GRCON Flow ignora pacotes sem `__pronto.json`, e **recusa o registro** de um
pacote cujo número de anexos na fila seja menor do que o `attachment_count`
declarado no marcador — ou cujo arquivo esteja na pasta mas não possa ser
aberto. Depois do registro, o navegador grava `<ID>__importado.json` com o
protocolo, os anexos enviados e a situação da triagem. Arquivos `true__` são
imagens incorporadas e não entram na solicitação. O formato anterior em
subpastas permanece compatível.

> **Files On-Demand.** Marque a pasta `GRCON Flow\Fila` como **“Sempre manter
> neste dispositivo”** no Explorer. Sem isso o OneDrive guarda apenas um
> marcador on-line, e o navegador não consegue ler o anexo quando a rede
> oscila.

## Fluxo `GRCON Flow - Capturar e-mails`

1. **Recurrence / Recorrência**
   - Frequência: `Minute` / `Minuto`
   - Intervalo: `5`
   - Controle de simultaneidade: ativado, grau `1`

2. **Get emails (V3) / Obter emails (V3)** — Office 365 Outlook
   - Mailbox: a caixa que a equipe combinou monitorar. Prefira uma caixa ou
     pasta cujo acesso não dependa de uma pessoa só — ver *Uso pela equipe*.
   - Folder: `Inbox/GRCON FLOW/Entrada`
   - Fetch Only Unread Messages: `No`
   - Include Attachments: `Yes`
   - Top: `25`

3. **Apply to each / Aplicar a cada** usando `value` da etapa anterior.

4. Dentro do loop, criar o **Scope / Escopo** `Preparar pacote`:

   1. **Compose / Compor** `ID do pacote`:

      ```text
      concat(formatDateTime(utcNow(),'yyyyMMddHHmmssfff'),'-',guid())
      ```

   2. **Compose / Compor** `Metadados` com o objeto abaixo. Os nomes das
      propriedades aceitam as formas retornadas pelo Outlook V3; o aplicativo
      também é tolerante às variações de maiúsculas do conector.

      ```text
      setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(setProperty(json('{}'),'schema_version',1),'id',item()?['id']),'internetMessageId',item()?['internetMessageId']),'subject',item()?['subject']),'body',item()?['body']),'bodyPreview',item()?['bodyPreview']),'from',item()?['from']),'receivedDateTime',item()?['receivedDateTime']),'importance',item()?['importance'])
      ```

   3. **Create file / Criar arquivo** — OneDrive for Business
      - Folder Path: `/GRCON Flow/Fila`
      - File Name: `<saída de ID do pacote>__mensagem.json`
      - File Content: `string(outputs('Metadados'))`

   4. **Apply to each / Aplicar a cada** usando `Attachments` do e-mail. Dentro
      do loop, usar **Create file / Criar arquivo**:
      - Folder Path: `/GRCON Flow/Fila`
      - File Name:

        ```text
        concat(outputs('ID_do_pacote'),'__anexo__',string(item()?['IsInline']),'__',item()?['Name'])
        ```

      - File Content: `base64ToBinary(item()?['ContentBytes'])`

      O nome recebe `true__` para imagem incorporada e `false__` para anexo
      normal. Na leitura da fila, o GRCON Flow descarta automaticamente os
      arquivos `true__` e remove `false__` do nome exibido, sem duplicar o
      conteúdo dos anexos dentro de `mensagem.json`.

   5. Depois dos anexos, criar `<ID do pacote>__pronto.json` em
      `/GRCON Flow/Fila`. O conteúdo precisa dizer **quantos anexos o e-mail
      tinha** — é o que permite ao GRCON Flow distinguir "este e-mail não tinha
      anexo" de "o anexo ainda não sincronizou":

      ```text
      concat('{"schema_version":2,"attachment_count":',
             string(length(triggerOutputs()?['body/Attachments'])),
             ',"message_id":"', item()?['internetMessageId'], '"}')
      ```

      Dentro do *Apply to each* das mensagens, `length(...)` deve apontar para a
      coleção `Attachments` **daquele** e-mail — no editor, o campo dinâmico
      *Attachments* do item corrente. A contagem inclui as imagens incorporadas
      da assinatura; o aplicativo desconta as que vierem com `true__`.

      Pacote gravado no formato antigo (`{"schema_version":1}`, sem contagem)
      continua sendo lido, só que sem a conferência de completude.

   6. **Move email (V2) / Mover email (V2)** — Office 365 Outlook
      - Message Id: `id` do e-mail do loop externo
      - Folder: `Inbox/GRCON FLOW/Processados`

5. Logo depois de `Mover para Processados`, adicionar outro **Move email (V2)**
   chamado `Mover para Erros`, apontando para `Inbox/GRCON FLOW/Erros`. Em
   **Settings > Run after**, desmarcar `Is successful` e marcar `Has failed`,
   `Has timed out` e `Is skipped` para a etapa `Mover para Processados`. Se esse
   último movimento também falhar, a mensagem permanece em `Entrada` e nada é
   perdido.

## Regras operacionais

- O usuário apenas move para `Entrada` os e-mails que devem virar solicitação.
- O fluxo nunca apaga mensagens.
- Mensagem já lida também é processada; a pasta dedicada é a fila.
- Anexo embutido de assinatura (`IsInline`) não entra no GRCON Flow.
- Pacote incompleto não aparece no painel porque não possui `__pronto.json`.
- Repetir a importação devolve o mesmo protocolo para o mesmo operador.
- O arquivo `<ID>__importado.json` permite retomar uma falha de anexo.
- A triagem da LD continua ocorrendo somente depois da confirmação da equipe.
- Pacote com anexo faltando aparece como **Incompleto** e não pode ser
  registrado até a sincronização terminar.

## Uso pela equipe

A fila não deve depender da conta de uma pessoa. Duas formas, ambas com
conector padrão e sem pedir nada ao TI:

1. **Pasta do OneDrive compartilhada** (imediata) — mantenha *um* fluxo, na
   conta de quem o administra, e compartilhe a pasta `GRCON Flow/Fila` com
   edição para a equipe. Cada pessoa sincroniza essa pasta e aponta o navegador
   para ela. Como o `__importado.json` fica visível para todos, ninguém importa
   de novo o que outra pessoa já registrou.
2. **Biblioteca do SharePoint** (recomendada a médio prazo) — troque a ação de
   gravação para *Create file* do conector **SharePoint**, também padrão,
   apontando para uma biblioteca da equipe. A biblioteca sincronizada aparece no
   Explorer como qualquer pasta, então o GRCON Flow não muda: continua sendo um
   diretório escolhido pela pessoa. A fila deixa de pertencer a uma conta
   pessoal e sobrevive a férias e desligamentos.

Criar uma **caixa compartilhada** do Microsoft 365 resolveria o mesmo problema
pelo lado do Outlook, mas **depende do TI** — não presuma a autorização.

O aplicativo recusa protocolo duplicado para o mesmo e-mail mesmo que duas
pessoas importem o mesmo pacote, pela chave derivada do `internetMessageId`.
