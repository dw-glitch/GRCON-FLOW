import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const core = require("./core.js");
globalThis.TriagemCore = core;
const requests = require("./requests_core.js");

const parsed = requests.documentFromFileName("C1O_RNEST_U32_10.2.1.2_TUB_RIR_nt-NF-1288-CONEXOES_0001.pdf");
assert.equal(parsed.document, "C1O_RNEST_U32_10.2.1.2_TUB_RIR_nt-NF-1288-CONEXOES");

const rows = requests.buildManualControlRows([
  { document: "DOC-A" },
  { document: "DOC-B" }
], { owner: "Responsável", requester: "Área", requestType: "POSTAGEM NO SIGEM" }, [{ protocol: "556" }]);
assert.equal(rows[0].item, "557");
assert.equal(rows[1].item, "558");
assert.equal(rows[0].requestType, "POSTAGEM NO SIGEM");

const types = requests.requestTypeList(null);
assert.ok(types.some((item) => item.code === "POSTAGEM_SIGEM"));
assert.ok(types.some((item) => item.code === "ALOCACAO"));

console.log("Testes do módulo independente concluídos com sucesso.");
