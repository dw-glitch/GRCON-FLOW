#!/usr/bin/env node
// Confere a sintaxe de todo JavaScript próprio do GRCON Flow.
// As bibliotecas de terceiros (xlsx, exceljs, supabase) ficam de fora: são
// pacotes minificados e conferi-los só gastaria tempo de CI.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const terceiros = new Set(["xlsx.full.min.js", "exceljs.min.js", "supabase.min.js"]);

const arquivos = fs.readdirSync(root)
  .filter((nome) => nome.endsWith(".js") && !terceiros.has(nome))
  .sort();

const falhas = [];
for (const nome of arquivos) {
  try {
    execFileSync(process.execPath, ["--check", path.join(root, nome)], { stdio: "pipe" });
  } catch (erro) {
    falhas.push(`${nome}: ${String(erro.stderr || erro.message).split("\n").slice(0, 3).join(" ")}`);
  }
}

if (falhas.length) {
  falhas.forEach((falha) => console.error(`- ${falha}`));
  process.exit(1);
}
console.log(`OK — ${arquivos.length} arquivos JavaScript com sintaxe válida.`);
