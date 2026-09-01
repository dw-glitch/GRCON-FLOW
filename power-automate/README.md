# Power Automate — Outlook para GRCON Flow

Fluxo cloud com conectores padrão do Microsoft 365. Não usa HTTP, conector
personalizado, Microsoft Entra, gateway local, PowerShell nem licença Premium.

## Estrutura esperada

Na caixa compartilhada do Outlook:

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

Cada e-mail concluído vira uma subpasta de `Fila`:

```text
Fila
└── 20260901153000123-<guid>
    ├── mensagem.json
    ├── documento.pdf
    ├── planilha.xlsx
    └── pronto.json
```

O GRCON Flow ignora pastas sem `pronto.json`. Depois do registro, o navegador
grava `importado.json` com o protocolo, os anexos enviados e a situação da
triagem.

## Fluxo `GRCON Flow - Capturar e-mails`

1. **Recurrence / Recorrência**
   - Frequência: `Minute` / `Minuto`
   - Intervalo: `5`
   - Controle de simultaneidade: ativado, grau `1`

2. **Get emails (V3) / Obter emails (V3)** — Office 365 Outlook
   - Original Mailbox Address: endereço da caixa compartilhada
   - Folder: `GRCON Flow/Entrada`
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

   3. **Create new folder / Criar nova pasta** — OneDrive for Business
      - Pasta pai: `/GRCON Flow/Fila`
      - Nome: saída de `ID do pacote`

   4. **Create file / Criar arquivo** — OneDrive for Business
      - Folder Path: `/GRCON Flow/Fila/<saída de ID do pacote>`
      - File Name: `mensagem.json`
      - File Content: `string(outputs('Metadados'))`

   5. **Apply to each / Aplicar a cada** usando `Attachments` do e-mail.
      - Adicionar uma condição: `IsInline` é igual a `false`.
      - No ramo **Yes**, usar **Create file / Criar arquivo**:
        - Folder Path: a pasta do pacote
        - File Name: `Name` do anexo
        - File Content: `base64ToBinary(item()?['ContentBytes'])`

   6. Depois dos anexos, criar `pronto.json` na pasta do pacote, com o conteúdo:

      ```json
      {"schema_version":1}
      ```

   7. **Move email (V2) / Mover email (V2)** — Office 365 Outlook
      - Message Id: `id` do e-mail do loop externo
      - Folder: `GRCON Flow/Processados`
      - Original Mailbox Address: a mesma caixa compartilhada

5. Criar o **Scope / Escopo** `Em caso de erro`, configurado para executar
   somente quando `Preparar pacote` falhar ou expirar. Dentro dele, mover o
   e-mail para `GRCON Flow/Erros`. Se esse último movimento também falhar, a
   mensagem permanece em `Entrada` e nada é perdido.

## Regras operacionais

- O usuário apenas move para `Entrada` os e-mails que devem virar solicitação.
- O fluxo nunca apaga mensagens.
- Mensagem já lida também é processada; a pasta dedicada é a fila.
- Anexo embutido de assinatura (`IsInline`) não entra no GRCON Flow.
- Pasta incompleta não aparece no painel porque não possui `pronto.json`.
- Repetir a importação devolve o mesmo protocolo para o mesmo operador.
- O arquivo `importado.json` permite retomar uma falha de anexo.
- A triagem da LD continua ocorrendo somente depois da confirmação da equipe.
