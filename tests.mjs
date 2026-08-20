/**
 * GRCON Flow — testes.
 *
 * Cobrem as regras que, se quebrarem, quebram o produto em silêncio: a
 * normalização de código (que decide se um documento é achado na LD), o
 * caminho de quem não tem código, e o formato das 26 colunas do Controle de
 * Solicitações.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const checks = [];
const check = (nome, fn) => { fn(); checks.push(nome); };

// Os arquivos do Flow são IIFEs que se penduram em `window`. Um objeto global
// mínimo basta para exercitá-los fora do navegador.
const janela = {};
globalThis.window = janela;
janela.TriagemCore = require(path.join(root, "core.js"));
janela.GrconRequestsCore = require(path.join(root, "requests_core.js"));
janela.GrconRequestsReport = require(path.join(root, "requests_report.js"));
janela.document = { createElement: () => ({ style: {} }) };

await import(`file://${path.join(root, "flow_docs.js")}`);
await import(`file://${path.join(root, "flow_export.js")}`);

const Docs = janela.FlowDocs;
const Export = janela.FlowExport;
const Report = janela.GrconRequestsReport;

// ── Normalização e identificação ───────────────────────────────────────────

check("o código informado é normalizado do mesmo jeito que a LD é indexada", () => {
  // Se as duas pontas normalizassem diferente, um documento gravado com uma
  // grafia jamais seria encontrado pela outra.
  const core = janela.TriagemCore;
  const codigo = "c1o_rnest_u32_3.1.1.1_ins_rir_spe-ast-320019";
  assert.equal(Docs.chave(codigo), core.key(codigo));
  assert.equal(Docs.chave(codigo), Docs.chave(codigo.toUpperCase()));
});

check("documento ET viaja com a forma alternativa do nt-", () => {
  // É o que permite achar na LD um documento informado na outra grafia.
  const item = Docs.itemDeCodigo("C1O_RNEST_U32_10.2.1.2_TUB_RIR_nt-NF-1288-CONEXOES");
  assert.ok(item.document_key, "o código normalizado precisa existir");
  assert.notEqual(item.nt_key, item.document_key, "a alternativa não pode repetir a principal");
  assert.ok(item.nt_key.length > 0, "documento ET tem forma alternativa");
});

check("código não é inventado a partir de nome de arquivo sem código", () => {
  const itens = Docs.deArquivos([{ name: "digitalizar0001.pdf" }, { name: "MA-5290.00-22000-ABC-C1O-001_0001.pdf" }]);
  assert.equal(itens.length, 2, "todo arquivo vira item, com ou sem código");
  const comCodigo = itens.find((item) => item.document);
  assert.equal(comCodigo.document, "MA-5290.00-22000-ABC-C1O-001");
  const semCodigo = itens.find((item) => !item.document);
  assert.equal(semCodigo.document_key, "", "sem código reconhecido, nada é preenchido");
  assert.equal(semCodigo.file_name, "digitalizar0001.pdf", "o nome do arquivo fica como referência");
});

check("ponto do código não é confundido com extensão", () => {
  const [item] = Docs.deArquivos([{ name: "LI-5290.00-22313-950-1LV-001" }]);
  assert.equal(item.document, "LI-5290.00-22313-950-1LV-001");
});

check("uma referência solta é encaminhada por parecer código ou por parecer título", () => {
  // Não se cria código nenhum: o que muda é para qual busca o item vai.
  assert.equal(Docs.pareceCodigo("5290.00-22313-91A-C1O-004"), true);
  assert.equal(Docs.pareceCodigo("Relatório de Inspeção da Válvula X"), false);
  assert.equal(Docs.pareceCodigo("ABC"), false, "curto demais para ser código");
  assert.equal(Docs.pareceCodigo("SEM-DIGITOS-AQUI"), false, "código sempre tem dígito");

  const porCodigo = Docs.itemDeReferencia("5290.00-22313-91A-C1O-004");
  assert.ok(porCodigo.document_key, "vai para a busca por código");
  const porTitulo = Docs.itemDeReferencia("Relatório de Inspeção da Válvula X");
  assert.equal(porTitulo.document_key, "", "não vira código");
  assert.equal(porTitulo.requested_title, "Relatório de Inspeção da Válvula X");
});

check("item só com título é um item válido", () => {
  // É o caso de "Localizar código pelo título": registrar precisa funcionar
  // sem código nenhum.
  const item = Docs.itemDeTitulo("Relatório de Inspeção da Válvula X", "TAG 320019");
  assert.equal(item.document, "");
  assert.equal(item.document_key, "");
  assert.equal(item.requested_title, "Relatório de Inspeção da Válvula X");
  assert.equal(item.reference, "TAG 320019");
});

check("repetição sai pelo código, e itens sem código nunca são descartados", () => {
  const { itens, removidos } = Docs.semRepetidos([
    Docs.itemDeCodigo("MA-5290.00-22000-ABC-C1O-001"),
    Docs.itemDeCodigo("ma-5290.00-22000-abc-c1o-001", { titulo: "Título que chegou depois" }),
    Docs.itemDeTitulo("Uma pergunta"),
    Docs.itemDeTitulo("Outra pergunta"),
  ]);
  assert.equal(removidos.length, 1, "o código repetido sai");
  assert.equal(itens.length, 3, "os dois itens sem código permanecem");
  assert.equal(itens[0].requested_title, "Título que chegou depois", "o título informado depois é preservado");
});

// ── Exportação ─────────────────────────────────────────────────────────────

check("a exportação reproduz as 26 colunas do Controle de Solicitações", () => {
  const cabecalhos = Report.CONTROL_COLUMNS.map((coluna) => coluna.header);
  assert.equal(cabecalhos.length, 26);
  assert.equal(cabecalhos[0], "ITEM");
  assert.equal(cabecalhos[1], "Responsavel pela atividade");
  assert.equal(cabecalhos[5], "Descrição da Solicitação");
  assert.equal(cabecalhos[23], "Disponibilizado no PW – N‑1710");
  assert.equal(cabecalhos[25], "Data de inclusão do status");
});

check("uma linha da view vira uma linha do Controle sem inventar campo", () => {
  const linha = Export.linhaDoControle({
    protocol: "FLOW-2026-000158",
    item_number: 1,
    type_label: "Postagem no SIGEM",
    requester_name: "João Silva",
    requester_area: "Engenharia",
    received_at: "2026-08-19T12:00:00Z",
    document: "MA-5290.00-22000-ABC-C1O-001",
    allocation: "C1O-ALOC-CM-0028-2026",
    sigem_status: "Em Análise",
    ld_name: "LD_004",
    ld_version_label: "3",
    classification: "PRONTO",
    request_status: "em_execucao",
    observations: "",
    triage_rule: "Ocorrência única nas LDs vigentes.",
  }, 0);

  assert.equal(linha.item, "1");
  assert.equal(linha.document, "MA-5290.00-22000-ABC-C1O-001");
  assert.equal(linha.requester, "João Silva / Engenharia");
  assert.equal(linha.allocation, "C1O-ALOC-CM-0028-2026");
  assert.equal(linha.origin, "GRCON FLOW");
  assert.equal(linha.needsLdInclusion, "não", "localizado na LD não precisa de inclusão");
  assert.equal(linha.overallStatus, "Em execução");
  // Etapas que ainda não aconteceram ficam vazias — a planilha as escreve
  // como "na", que é a convenção dela para "não se aplica".
  assert.equal(linha.fiscal1ReturnedAt, "");
  assert.equal(linha.pwN1710, "");

  const colunas = Report.controlRows([linha])[0];
  assert.equal(colunas.length, 26);
  assert.equal(colunas[0], "1");
  assert.equal(colunas[15], "na", "campo não apurado sai como na");
});

check("item sem código exporta sem código, com o título dito na observação", () => {
  const linha = Export.linhaDoControle({
    protocol: "FLOW-2026-000159",
    requested_title: "Relatório de Inspeção da Válvula X",
    classification: "IDENTIFICACAO_PENDENTE",
    request_status: "recebido",
    type_label: "Localizar código pelo título",
    requester_name: "Maria",
  }, 0);
  assert.equal(linha.document, "", "nenhum código é inventado");
  assert.match(linha.observations, /Sem código informado/);
  assert.match(linha.observations, /Relatório de Inspeção da Válvula X/);
  assert.equal(linha.needsLdInclusion, "", "sem consulta concluída, quem responde é a pessoa");
});

check("documento não localizado é dito como tal e ainda assim exporta", () => {
  const linha = Export.linhaDoControle({
    document: "MA-0000.00-00000-XXX-C1O-999",
    classification: "NAO_LOCALIZADO",
    request_status: "recebido",
    requester_name: "Carlos",
    type_label: "Inclusão na LD",
  }, 4);
  assert.equal(linha.item, "5");
  assert.equal(linha.document, "MA-0000.00-00000-XXX-C1O-999");
  assert.equal(linha.needsLdInclusion, "sim");
  assert.equal(linha.allocation, "", "sem alocação apurada, o campo fica vazio");
});

check("a cópia por tabulação sai com as 26 colunas", () => {
  const registros = [{ protocol: "FLOW-2026-000160", document: "ABC-001", requester_name: "Ana", request_status: "recebido" }];
  const semCabecalho = Export.copiar(registros, false);
  assert.equal(semCabecalho.split("\t").length, 26);
  const comCabecalho = Export.copiar(registros, true);
  assert.equal(comCabecalho.split("\n").length, 2);
  assert.match(comCabecalho, /^ITEM\t/);
});

// ── Pacote publicado ───────────────────────────────────────────────────────

check("as páginas só apontam para arquivos que existem no pacote", () => {
  const paginas = ["index.html", "solicitar.html", "painel.html", "acompanhar.html"];
  paginas.forEach((pagina) => {
    const html = fs.readFileSync(path.join(root, pagina), "utf8");
    for (const achado of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css|ico|png))"/g)) {
      const alvo = achado[1];
      if (/^https?:/.test(alvo)) continue;
      assert.ok(fs.existsSync(path.join(root, alvo)), `${pagina} aponta para ${alvo}, que não existe`);
    }
  });
});

check("as quatro rotas do aplicativo existem", () => {
  ["index.html", "solicitar.html", "painel.html", "acompanhar.html"]
    .forEach((pagina) => assert.ok(fs.existsSync(path.join(root, pagina)), `falta ${pagina}`));
  const vercel = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
  assert.equal(vercel.cleanUrls, true, "sem cleanUrls, /solicitar e /painel não resolvem");
});

check("nenhum vestígio do banco do GRCON principal", () => {
  // O GRCON Flow tem banco próprio. Uma referência ao projeto antigo aqui
  // significaria que os dois voltaram a compartilhar base.
  const proibidos = [/kvyrttccwzdhasplfxnr/i, /grcon_cloud_config/i, /sol_members/i, /GRCON_SOLICITACOES_CONFIG/];
  fs.readdirSync(root)
    .filter((nome) => /\.(js|html|json)$/.test(nome) && !/\.min\.js$/.test(nome))
    .forEach((nome) => {
      const conteudo = fs.readFileSync(path.join(root, nome), "utf8");
      proibidos.forEach((padrao) => {
        assert.doesNotMatch(conteudo, padrao, `${nome} ainda cita o banco do GRCON principal (${padrao})`);
      });
    });
});

check("a configuração publicada não carrega chave secreta", () => {
  const config = fs.readFileSync(path.join(root, "flow_config.js"), "utf8");
  assert.doesNotMatch(config, /sb_secret_/, "chave secreta jamais vai para o navegador");
  assert.doesNotMatch(config, /service_role/, "service_role ignora a RLS e não pode ser publicada");
  assert.match(config, /supabaseUrl/);
  assert.match(config, /https:\/\/[a-z0-9]+\.supabase\.co/);
});

console.log(JSON.stringify({ app: "GRCON Flow", passou: true, testes: checks.length, nomes: checks }, null, 2));
