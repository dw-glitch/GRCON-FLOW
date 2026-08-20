import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.dirname(aqui);
const require = createRequire(import.meta.url);
const arquivos = process.argv.slice(2);
if (!arquivos.length) {
  console.error("Uso: node scripts/auditar-lds-reais.mjs <LD1.xlsx> [LD2.xlsx ...]");
  process.exit(2);
}

const janela = { crypto: webcrypto };
globalThis.window = janela;
janela.XLSX = require(path.join(raiz, "xlsx.full.min.js"));
globalThis.XLSX = janela.XLSX;
janela.TriagemCore = require(path.join(raiz, "core.js"));
janela.GrconRequestsCore = require(path.join(raiz, "requests_core.js"));
await import(`file://${path.join(raiz, "flow_docs.js")}`);

const migracao = fs.readFileSync(path.join(raiz, "database/migrations/flow_13_versioned_norms.sql"), "utf8");
const blocoTipos = migracao.match(/-- Tipos de relatório[\s\S]*?\$codes\$([\s\S]*?)\$codes\$/);
const regras = {
  emissores: ["C1O"], unidades: ["U32"],
  tipos_relatorio: blocoTipos ? blocoTipos[1].split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : [],
};

function comoArquivo(caminho) {
  const bytes = fs.readFileSync(caminho);
  const stat = fs.statSync(caminho);
  return {
    name: path.basename(caminho), size: bytes.length, lastModified: stat.mtimeMs,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

const resultados = [];
for (const caminho of arquivos) {
  const fonte = await janela.FlowDocs.lerFonteLd(comoArquivo(caminho));
  const bloqueada = janela.FlowDocs.analisarFonteLd(fonte, { regras });
  const resolvida = janela.FlowDocs.analisarFonteLd(fonte, { regras, resolverConflitos: "linha_mais_recente" });

  assert.ok(fonte.abas.some((aba) => aba.papel === "tecnica"), `${path.basename(caminho)} não tem aba técnica reconhecida`);
  assert.equal(resolvida.documentos.some((item) => item.sheet.toUpperCase() === "COLAR SIGEM"), false,
    `${path.basename(caminho)} contaminou o índice com histórico SIGEM`);
  assert.equal(new Set(resolvida.documentos.map((item) => item.document_key)).size, resolvida.documentos.length,
    `${path.basename(caminho)} manteve chave duplicada`);
  if (bloqueada.conflitos.length) assert.equal(bloqueada.podePublicar, false,
    `${path.basename(caminho)} deveria bloquear conflitos não aprovados`);
  assert.equal(resolvida.podePublicar, true, `${path.basename(caminho)} deveria ficar publicável após a resolução explícita`);

  resultados.push({
    arquivo: path.basename(caminho),
    revisao_detectada: fonte.ldVersion,
    abas: fonte.abas,
    linhas_tecnicas_padrao: resolvida.relatorio.technical_rows_read,
    historico_excluido: resolvida.relatorio.history_rows_excluded,
    documentos_unicos: resolvida.documentos.length,
    duplicatas_identicas: resolvida.relatorio.identical_duplicates_removed,
    conflitos: resolvida.conflitos.length,
    alertas_de_codigo: resolvida.alertasCodigo.length,
  });
}

console.log(JSON.stringify({ passou: true, arquivos: resultados.length, resultados }, null, 2));
