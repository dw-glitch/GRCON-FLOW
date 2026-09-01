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
├── 20260901153000123-<guid>__anexo__documento.pdf
├── 20260901153000123-<guid>__anexo__planilha.xlsx
└── 20260901153000123-<guid>__pronto.json
```

O GRCON Flow ignora pacotes sem `__pronto.json`. Depois do registro, o navegador
grava `<ID>__importado.json` com o protocolo, os anexos enviados e a situação
da triagem. O formato anterior em subpastas permanece compatível.

## Fluxo `GRCON Flow - Capturar e-mails`

1. **Recurrence / Recorrência**
   - Frequência: `Minute` / `Minuto`
   - Intervalo: `5`
   - Controle de simultaneidade: ativado, grau `1`

2. **Get emails (V3) / Obter emails (V3)** — Office 365 Outlook
   - Mailbox: `vinicio.silva@agnet.com.br`
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

   4. **Apply to each / Aplicar a cada** usando `Attachments` do e-mail.
      - Adicionar uma condição: `IsInline` é igual a `false`.
      - No ramo **Yes**, usar **Create file / Criar arquivo**:
        - Folder Path: `/GRCON Flow/Fila`
        - File Name: `<ID do pacote>__anexo__<Name do anexo>`
        - File Content: `base64ToBinary(item()?['ContentBytes'])`

   5. Depois dos anexos, criar `<ID do pacote>__pronto.json` em
      `/GRCON Flow/Fila`, com o conteúdo:

      ```json
      {"schema_version":1}
      ```

   6. **Move email (V2) / Mover email (V2)** — Office 365 Outlook
      - Message Id: `id` do e-mail do loop externo
      - Folder: `Inbox/GRCON FLOW/Processados`

5. Criar o **Scope / Escopo** `Em caso de erro`, configurado para executar
   somente quando `Preparar pacote` falhar ou expirar. Dentro dele, mover o
   e-mail para `Inbox/GRCON FLOW/Erros`. Se esse último movimento também falhar, a
   mensagem permanece em `Entrada` e nada é perdido.

## Regras operacionais

- O usuário apenas move para `Entrada` os e-mails que devem virar solicitação.
- O fluxo nunca apaga mensagens.
- Mensagem já lida também é processada; a pasta dedicada é a fila.
- Anexo embutido de assinatura (`IsInline`) não entra no GRCON Flow.
- Pacote incompleto não aparece no painel porque não possui `__pronto.json`.
- Repetir a importação devolve o mesmo protocolo para o mesmo operador.
- O arquivo `<ID>__importado.json` permite retomar uma falha de anexo.
- A triagem da LD continua ocorrendo somente depois da confirmação da equipe.
