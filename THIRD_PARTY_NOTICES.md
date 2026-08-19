# Bibliotecas de terceiros

O GRCON distribui bibliotecas JavaScript vendorizadas para operar também offline. Os cabeçalhos originais devem ser preservados.

| Arquivo | Projeto | Versão identificável | Origem |
| --- | --- | --- | --- |
| `exceljs.min.js` | ExcelJS | cabeçalho de build 2023-10-19 | https://github.com/exceljs/exceljs |
| `jszip.min.js` | JSZip | 3.10.1 | https://github.com/Stuk/jszip |
| `xlsx.full.min.js` | SheetJS Community Edition | não declarada no bundle | https://git.sheetjs.com/sheetjs/sheetjs |
| `supabase.min.js` | Supabase JavaScript | não declarada no bundle | https://github.com/supabase/supabase-js |

Os hashes SHA-256 aceitos estão em `vendor-manifest.json` e são conferidos pelo CI. Uma atualização deve registrar versão, origem, licença e novo hash antes da publicação.

Este aviso não substitui os textos de licença dos projetos de origem.
