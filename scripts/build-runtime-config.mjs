import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Gera flow_config.js com o endereço do Supabase do GRCON Flow.
//
// A URL e a chave publicável não são segredos: elas são feitas para viajar no
// navegador e o que protege os dados é a RLS do banco. Ainda assim, ambas
// podem ser trocadas por variável de ambiente, para que um outro ambiente
// (homologação, por exemplo) aponte para outro projeto sem tocar no código.
//
// O que NUNCA entra aqui é a service_role: ela ignora a RLS.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const clean = (value = "") => String(value).trim();

// Projeto Supabase exclusivo do GRCON Flow.
const PADRAO_URL = "https://hbfcqkbjrcmpdljlklol.supabase.co";
const PADRAO_KEY = "sb_publishable_dxFhAsqOMcLUvYCtjQ_HTg_aG0qCkI0";

const url = clean(process.env.FLOW_SUPABASE_URL) || clean(process.env.SUPABASE_URL) || PADRAO_URL;
const key = clean(process.env.FLOW_SUPABASE_ANON_KEY)
  || clean(process.env.SUPABASE_ANON_KEY)
  || clean(process.env.SUPABASE_PUBLISHABLE_KEY)
  || PADRAO_KEY;

if (/sb_secret_|service_role/i.test(key)) {
  throw new Error("A chave informada parece ser a service_role. Use a chave publicável (sb_publishable_…).");
}
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) {
  throw new Error(`FLOW_SUPABASE_URL inválida: ${url}`);
}

const config = {
  appName: "GRCON Flow",
  supabaseUrl: url,
  supabaseKey: key,
  // Limites conferidos também no banco e no bucket do Storage.
  uploadMaxMb: Number(clean(process.env.FLOW_UPLOAD_MAX_MB)) || 25,
  ldUploadMaxMb: Number(clean(process.env.FLOW_LD_UPLOAD_MAX_MB)) || 100,
};

const saida = `/* Gerado por scripts/build-runtime-config.mjs — não editar à mão. */
window.FLOW_CONFIG = Object.freeze(${JSON.stringify(config, null, 2)});
`;

fs.writeFileSync(path.join(root, "flow_config.js"), saida, "utf8");
console.log(`flow_config.js gerado para ${url}`);
