# GRCON — Operação de Solicitações independente

Aplicativo extraído do GRCON principal contendo somente a Operação de Solicitações e as dependências documentais necessárias para ler LDs, fazer a triagem, acompanhar itens e exportar o Controle de Solicitações em Excel.

## O que foi preservado

- Nova solicitação e numeração contínua dos itens.
- Inclusão de documentos por arquivos ou lista colada.
- Consulta opcional a uma ou mais LDs com o mesmo motor documental usado pelo módulo original.
- Classificação sem aproximação ou adivinhação: localizado, validação manual ou não localizado.
- Edição em lote e tabela completa das 26 colunas do Controle de Solicitações.
- Exportação Excel e cópia das linhas.
- Painel de acompanhamento, filtros, indicadores, alteração de status/responsável e histórico.
- Tipos de solicitação configuráveis e regra de proprietário para alterá-los.
- Logo e identidade GRCON.

## O que foi removido

- Todo o restante do sistema GRCON.
- `grcon_cloud_app.js` e `grcon_cloud_config.js`.
- URL, chave, workspace e credenciais do Supabase do GRCON principal.
- Migrações SQL do banco do GRCON principal.
- Histórico de eGRDT, central de alocação, emissão, SIGEM posting e demais serviços que não pertencem à Operação de Solicitações.

## Persistência desacoplada

A UI chama somente `GrconSolicitacoesStorage`, em `solicitacoes_storage.js`. O driver padrão é `local`, que usa uma chave exclusiva de `localStorage` e não acessa nenhum banco externo.

Quando houver uma nova base Supabase, altere apenas a configuração. O schema novo e isolado fica em `database/schema.sql`; ele usa tabelas/funções `sol_*` e não depende de objetos do GRCON principal.

## Executar localmente

```bash
npm run dev
```

Abra `http://localhost:4173`.

## Validar o pacote

```bash
npm run verify
```

## Variáveis de ambiente

Copie `.env.example` para o ambiente de publicação. O `npm run build` gera `runtime-config.js` sem precisar editar o código da interface.

Enquanto `GRCON_STORAGE_DRIVER=local`, nenhuma credencial Supabase é usada.
