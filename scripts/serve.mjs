import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Servidor de desenvolvimento. Reproduz o `cleanUrls` da Vercel — /solicitar
// serve solicitar.html — para que o que se testa aqui seja o que roda lá.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 4173);

const tipos = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

function resolver(caminho) {
  const relativo = caminho === "/" ? "index.html" : caminho.replace(/^\/+/, "");
  const candidatos = /\.[a-z0-9]+$/i.test(relativo)
    ? [relativo]
    : [`${relativo}.html`, path.join(relativo, "index.html"), relativo];

  for (const candidato of candidatos) {
    const alvo = path.resolve(root, candidato);
    // Nada fora da pasta do projeto, mesmo com ../ no caminho.
    if (alvo !== root && !alvo.startsWith(root + path.sep)) continue;
    if (fs.existsSync(alvo) && fs.statSync(alvo).isFile()) return alvo;
  }
  return null;
}

http.createServer((req, res) => {
  const bruto = decodeURIComponent((req.url || "/").split("?")[0]);
  const alvo = resolver(bruto);
  if (!alvo) { res.writeHead(404); return res.end("Not found"); }
  fs.readFile(alvo, (erro, dados) => {
    if (erro) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, {
      "Content-Type": tipos[path.extname(alvo).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(dados);
  });
}).listen(port, "0.0.0.0", () => console.log(`GRCON Flow: http://localhost:${port}`));
