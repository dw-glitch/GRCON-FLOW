import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const clean = (value = "") => String(value).trim();
const role = ["owner", "admin", "operator", "viewer"].includes(clean(process.env.GRCON_USER_ROLE))
  ? clean(process.env.GRCON_USER_ROLE)
  : "owner";
const driver = clean(process.env.GRCON_STORAGE_DRIVER).toLowerCase() === "supabase" ? "supabase" : "local";

const config = {
  storageDriver: driver,
  supabaseUrl: clean(process.env.SUPABASE_URL),
  supabaseAnonKey: clean(process.env.SUPABASE_ANON_KEY),
  workspaceId: clean(process.env.GRCON_WORKSPACE_ID) || "default",
  role
};

if (driver === "supabase" && (!config.supabaseUrl || !config.supabaseAnonKey)) {
  throw new Error("GRCON_STORAGE_DRIVER=supabase exige SUPABASE_URL e SUPABASE_ANON_KEY do NOVO projeto.");
}

const output = `/* Gerado por scripts/build-runtime-config.mjs. Não versionar segredos. */\nwindow.GRCON_SOLICITACOES_CONFIG = Object.freeze(${JSON.stringify(config, null, 2)});\n`;
fs.writeFileSync(path.join(root, "runtime-config.js"), output, "utf8");
console.log(`runtime-config.js gerado em modo ${driver}.`);
