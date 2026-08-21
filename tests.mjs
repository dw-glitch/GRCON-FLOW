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

// ── Pré-análise segura de LD ──────────────────────────────────────────────

function fonteLd(registrosTecnicos, registrosHistoricos = [], abas = []) {
  return {
    nome: "LD_TESTE.xlsx", hash: "abc123", ldVersion: "Q",
    registrosTecnicos, registrosHistoricos,
    abas: abas.length ? abas : [
      { nome: "ET", papel: "tecnica", oculta: false, registros: registrosTecnicos.length, selecionadaPorPadrao: true },
      { nome: "Colar SIGEM", papel: "historico", oculta: false, registros: registrosHistoricos.length, selecionadaPorPadrao: false },
    ],
  };
}

check("histórico SIGEM nunca entra no índice vigente da LD", () => {
  const fonte = fonteLd([
    { document: "MA-5290.00-22000-ABC-C1O-001", documentKey: "MA-5290.00-22000-ABC-C1O-001", sheet: "N-1710", row: 10 },
  ], [
    { document: "MA-5290.00-22000-ABC-C1O-999", documentKey: "MA-5290.00-22000-ABC-C1O-999", sheet: "Colar SIGEM", row: 20 },
  ], [
    { nome: "N-1710", papel: "tecnica", oculta: false, registros: 1, selecionadaPorPadrao: true },
    { nome: "Colar SIGEM", papel: "historico", oculta: false, registros: 1, selecionadaPorPadrao: false },
  ]);
  const analise = Docs.analisarFonteLd(fonte);
  assert.equal(analise.documentos.length, 1);
  assert.equal(analise.relatorio.history_rows_excluded, 1);
  assert.doesNotMatch(JSON.stringify(analise.documentos), /C1O-999/);
});

check("aba técnica oculta exige seleção manual", () => {
  const fonte = fonteLd([
    { document: "MA-5290.00-22000-ABC-C1O-001", documentKey: "A", sheet: "N-1710", sheetHidden: 1, row: 10 },
    { document: "MA-5290.00-22000-ABC-C1O-002", documentKey: "B", sheet: "N-1710 MOD", row: 10 },
  ], [], [
    { nome: "N-1710", papel: "tecnica", oculta: true, registros: 1, selecionadaPorPadrao: false },
    { nome: "N-1710 MOD", papel: "tecnica", oculta: false, registros: 1, selecionadaPorPadrao: true },
  ]);
  const padrao = Docs.analisarFonteLd(fonte);
  assert.equal(padrao.documentos.length, 1);
  assert.equal(padrao.documentos[0].sheet, "N-1710 MOD");
  const explicita = Docs.analisarFonteLd(fonte, { abasIncluidas: ["N-1710", "N-1710 MOD"] });
  assert.equal(explicita.documentos.length, 2);
});

check("conflito bloqueia a LD até a regra ser assumida explicitamente", () => {
  const documento = "MA-5290.00-22000-ABC-C1O-001";
  const fonte = fonteLd([
    { document: documento, documentKey: documento, sheet: "N-1710", row: 10, revision: "A", title: "Título A" },
    { document: documento, documentKey: documento, sheet: "N-1710", row: 20, revision: "B", title: "Título B" },
  ], [], [{ nome: "N-1710", papel: "tecnica", oculta: false, registros: 2, selecionadaPorPadrao: true }]);
  const bloqueada = Docs.analisarFonteLd(fonte);
  assert.equal(bloqueada.podePublicar, false);
  assert.equal(bloqueada.conflitos.length, 1);
  assert.equal(bloqueada.documentos.length, 0);
  const aprovada = Docs.analisarFonteLd(fonte, { resolverConflitos: "linha_mais_recente" });
  assert.equal(aprovada.podePublicar, true);
  assert.equal(aprovada.documentos.length, 1);
  assert.equal(aprovada.documentos[0].revision, "B");
  assert.equal(aprovada.relatorio.conflict_resolution, "linha_mais_recente");
});

check("duplicatas idênticas são consolidadas sem criar falso conflito", () => {
  const registro = { document: "MA-5290.00-22000-ABC-C1O-001", documentKey: "DOC1", sheet: "N-1710", revision: "A", title: "Mesmo título" };
  const fonte = fonteLd([{ ...registro, row: 10 }, { ...registro, row: 11 }], [], [
    { nome: "N-1710", papel: "tecnica", oculta: false, registros: 2, selecionadaPorPadrao: true },
  ]);
  const analise = Docs.analisarFonteLd(fonte);
  assert.equal(analise.documentos.length, 1);
  assert.equal(analise.conflitos.length, 0);
  assert.equal(analise.relatorio.identical_duplicates_removed, 1);
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

check("a primeira aba do Excel tem as mesmas colunas visíveis no painel", () => {
  const headers = Export.COLUNAS_PAINEL.map((coluna) => coluna.header);
  assert.deepEqual(headers, [
    "PROTOCOLO", "TIPO", "SOLICITANTE", "RECEBIDA",
    "RESPONSÁVEL", "PROGRESSO", "STATUS", "PRAZO",
  ]);
  const painel = fs.readFileSync(path.join(root, "flow_painel.js"), "utf8");
  assert.match(painel, /FlowExport\.COLUNAS_PAINEL/,
    "a tela deve ler os cabeçalhos da mesma fonte usada pela planilha");
});

check("itens repetidos viram uma única linha de solicitação com progresso correto", () => {
  const linhas = Export.consolidarPainel([
    {
      protocol: "FLOW-2026-000200", type_label: "Postagem no SIGEM",
      requester_name: "Ana", requester_area: "Engenharia", received_at: "2026-08-20T10:00:00Z",
      owner_name: "Luiz", request_status: "em_execucao", request_due_at: "2026-08-30",
      item_status: "concluido",
    },
    {
      protocol: "FLOW-2026-000200", type_label: "Postagem no SIGEM",
      requester_name: "Ana", requester_area: "Engenharia", received_at: "2026-08-20T10:00:00Z",
      owner_name: "Luiz", request_status: "em_execucao", request_due_at: "2026-08-30",
      item_status: "em_execucao",
    },
  ]);
  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].requester, "Ana\nEngenharia");
  assert.equal(linhas[0].progress, "1/2");
  assert.equal(linhas[0].status, "Em execução");
  assert.match(linhas[0].due, /^30\/08\/2026/,
    "data sem hora não pode voltar um dia por causa do fuso do computador");
});

check("a exportação filtrada usa exatamente os protocolos visíveis", () => {
  const painel = fs.readFileSync(path.join(root, "flow_painel.js"), "utf8");
  assert.match(painel, /filtros\.protocolos = estado\.solicitacoes\.map/);
  assert.doesNotMatch(painel, /if \(estado\.filtros\.tipo\) \{ filtros\.tipo/,
    "reconstruir apenas parte dos filtros faria o Excel divergir da tela");
});

check("a planilha usa a mesma logo oficial do aplicativo", () => {
  const exportacao = fs.readFileSync(path.join(root, "flow_export.js"), "utf8");
  assert.match(exportacao, /attachBrandLogo\([^\n]+grcon-logo-report\.png/);
  assert.ok(fs.existsSync(path.join(root, "grcon-logo-app.png")));
  assert.ok(fs.existsSync(path.join(root, "grcon-logo-report.png")));
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

// ── Separação entre solicitante e equipe ───────────────────────────────────

check("a raiz é um roteador, não uma tela de escolha", () => {
  // A tela que perguntava "o que você quer fazer?" obrigava todo mundo a um
  // clique para chegar ao único lugar que lhe interessava.
  const home = fs.readFileSync(path.join(root, "flow_home.js"), "utf8");
  assert.doesNotMatch(home, /montarInicio|flow-portais|flow-portal/, "sobrou a tela de escolha");
  assert.match(home, /function destinoDoPapel/);
  assert.match(home, /ehEquipe\(\)\s*\?\s*"\/painel"\s*:\s*"\/solicitar"/,
    "a equipe vai para o painel e o restante para o formulário");
  const css = fs.readFileSync(path.join(root, "flow.css"), "utf8");
  assert.doesNotMatch(css, /\.flow-portal/, "sobrou o CSS dos portais");
});

check("o encaminhamento espera o perfil carregar", () => {
  // `ehEquipe()` lê o perfil; decidir antes dele existir jogaria a equipe em
  // /solicitar por um instante, e ela veria a tela errada piscar.
  const home = fs.readFileSync(path.join(root, "flow_home.js"), "utf8");
  assert.match(home, /Api\.auth\.session && Api\.auth\.profile/);
  assert.match(home, /aoMudar\(\(sessao, perfil\) => \{\s*if \(sessao && perfil\) encaminhar\(\);/);
});

check("uma rota protegida tem prioridade sobre o destino do papel", () => {
  // Quem clicou num link para /painel e precisou entrar volta para lá.
  const home = fs.readFileSync(path.join(root, "flow_home.js"), "utf8");
  assert.match(home, /destinoPretendido\(\) \|\| destinoDoPapel\(\)/);
});

check("a equipe lê o painel como primeiro link do topo", () => {
  const ui = fs.readFileSync(path.join(root, "flow_ui.js"), "utf8");
  assert.match(ui, /links\.unshift\(\{ href: "\/painel"/,
    "o painel precisa vir antes, não depois");
});

check("o aviso de área restrita sobrevive ao redirecionamento", () => {
  // Mostrado na página que está sendo abandonada, o aviso sumiria com ela.
  const ui = fs.readFileSync(path.join(root, "flow_ui.js"), "utf8");
  assert.match(ui, /\/solicitar\?aviso=\$\{encodeURIComponent\(motivo\)\}/);
  assert.match(ui, /function avisoDaUrl/);
  const solicitar = fs.readFileSync(path.join(root, "flow_solicitar.js"), "utf8");
  assert.match(solicitar, /avisoDaUrl\(\)/, "a página de destino precisa mostrar o aviso");
});

check("a aba Acesso é de administrador e existe de ponta a ponta", () => {
  const painel = fs.readFileSync(path.join(root, "flow_painel.js"), "utf8");
  assert.match(painel, /\{ chave: "acesso", rotulo: "Acesso", admin: true \}/);
  assert.match(painel, /montarAcesso\(conteudo\)/, "a aba precisa ser despachada");
  const admin = fs.readFileSync(path.join(root, "flow_admin.js"), "utf8");
  assert.match(admin, /montarTipos, montarUsuarios, montarAcesso/, "e exportada");
  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");
  ["dominios", "definirDominios", "listar", "definir", "remover"].forEach((metodo) => {
    assert.match(api, new RegExp(`\\b${metodo}\\b`), `falta ${metodo} no grupo acesso`);
  });
  assert.match(api, /usuarios, acesso, exportacao/, "o grupo acesso precisa ser exportado");
});

check("normas e catálogos são administráveis e versionados", () => {
  const painel = fs.readFileSync(path.join(root, "flow_painel.js"), "utf8");
  assert.match(painel, /\{ chave: "normas", rotulo: "Normas e códigos", admin: true \}/);
  assert.match(painel, /FlowNormas\.montar\(conteudo\)/);
  const pagina = fs.readFileSync(path.join(root, "painel.html"), "utf8");
  assert.match(pagina, /flow_normas\.js/);
  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");
  assert.match(api, /const normas = \{/);
  assert.match(api, /flow_active_code_rules/);
  const migration = fs.readFileSync(path.join(root, "database/migrations/flow_13_versioned_norms.sql"), "utf8");
  assert.match(migration, /create table if not exists public\.flow_norm_versions/i);
  assert.match(migration, /flow_norm_catalog_current_uidx/);
  assert.match(migration, /TIPOS_RELATORIO/);
});

check("texto e anexos da N-1710 preservam revisões independentes", () => {
  const migration = fs.readFileSync(path.join(root, "database/migrations/flow_16_norm_sources_and_files.sql"), "utf8");
  const esperadas = [
    ["A", "W"], ["B", "CJ"], ["C", "BF"], ["D", "BG"],
    ["E", "D"], ["F", "G"], ["G", "CN"],
  ];
  esperadas.forEach(([anexo, revisao]) => {
    assert.match(migration, new RegExp(`N-1710-ANEXO-${anexo}[^\\n]+['\"]${revisao}['\"]`),
      `falta a revisão ${revisao} do Anexo ${anexo}`);
  });
  assert.match(migration, /Formulários para Emissão de Documentos Técnicos de Engenharia/,
    "o título da N-381 precisa acompanhar a capa fornecida");
});

check("PDF pode completar uma revisão normativa pré-cadastrada", () => {
  const migration = fs.readFileSync(path.join(root, "database/migrations/flow_16_norm_sources_and_files.sql"), "utf8");
  assert.match(migration, /on conflict \(norm_id,revision\) do update/i);
  assert.match(migration, /where btrim\(coalesce\(flow_norm_versions\.storage_path,''\)\)=''/i);
  assert.match(migration, /status in \('rascunho','ativa','substituida'\)/i,
    "vigentes e históricas sem PDF precisam aceitar o vínculo");
  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");
  assert.match(api, /createSignedUrl\(seguro, 600\)/,
    "o PDF privado precisa abrir por URL temporária");
});

check("catálogos refletem os anexos da N-1710 e não misturam CT ou SIT", () => {
  const migration = fs.readFileSync(path.join(root, "database/migrations/flow_16_norm_sources_and_files.sql"), "utf8");
  ["INSTALACOES_N1710", "AREAS_ATIVIDADE_N1710", "CLASSES_SERVICO_N1710",
    "AREAS_ATIVIDADE_NAVAL_N1710", "CLASSES_SERVICO_NAVAL_N1710"].forEach((catalogo) => {
    assert.match(migration, new RegExp(catalogo), `falta o catálogo ${catalogo}`);
  });
  assert.match(migration, /\('CT','Consulta Técnica[^\n]+false\)/);
  assert.match(migration, /\('SIT','Solicitação de Informação Técnica[^\n]+false\)/);
  const normas = fs.readFileSync(path.join(root, "flow_normas.js"), "utf8");
  assert.match(normas, /Abrir PDF/);
  assert.match(normas, /N-1710 Anexo F/);
});

check("o proprietário inicial depende de e-mail preparado, não de corrida pelo primeiro cadastro", () => {
  const migration = fs.readFileSync(path.join(root, "database/migrations/flow_14_secure_owner_and_permissions.sql"), "utf8");
  assert.match(migration, /flow_owner_bootstrap/);
  assert.match(migration, /flow_prepare_owner_bootstrap/);
  assert.match(migration, /E-mail preparado para o primeiro proprietário/);
  assert.doesNotMatch(migration, /Primeiro acesso do sistema/);
  assert.match(migration, /revoke insert,update,delete on public\.flow_profiles from authenticated/i);
});

check("toda nova solicitação notifica a equipe ativa em tempo real", () => {
  const migration = fs.readFileSync(path.join(root, "database/migrations/flow_14_secure_owner_and_permissions.sql"), "utf8");
  assert.match(migration, /flow_notify_new_request_trigger/);
  assert.match(migration, /alter publication supabase_realtime add table public\.flow_notifications/i);
  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");
  assert.match(api, /postgres_changes/);
  assert.match(api, /flow-notificacoes-/);
});

check("o painel mantém uma caixa persistente de notificações não lidas", () => {
  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");
  assert.match(api, /async contarNaoLidas\(\)/,
    "o contador não pode depender apenas das 30 notificações exibidas");
  assert.match(api, /async marcarTodasLidas\(\)/);
  assert.match(api, /\.eq\("user_id", state\.session\.user\.id\)\.is\("read_at", null\)/,
    "a consulta deve ser explicitamente limitada ao usuário conectado");

  const painel = fs.readFileSync(path.join(root, "flow_painel.js"), "utf8");
  assert.match(painel, /id: "painel-notificacoes-botao"/);
  assert.match(painel, /id: "painel-notificacoes-menu"/);
  assert.match(painel, /abrirNotificacao\(notificacao\)/,
    "clicar no alerta deve abrir diretamente a solicitação relacionada");
  assert.match(painel, /Api\.notificacoes\.marcarLida\(notificacao\.id\)/);
  assert.match(painel, /Api\.notificacoes\.marcarTodasLidas\(\)/);
  assert.match(painel, /carregarNotificacoes\(\)/,
    "a caixa precisa recuperar avisos perdidos enquanto a pessoa estava fora do painel");
  assert.match(painel, /evento\.composedPath\(\)\.includes\(central\)/,
    "redesenhar o conteúdo do botão não pode fechar a caixa no mesmo clique");
});

check("todo tipo de solicitação aceita somente até cinco anexos PDF, Excel e Word de 10 MB", () => {
  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");
  ["pdf", "xls", "xlsx", "xlsm", "doc", "docx"].forEach((extensao) => {
    assert.match(api, new RegExp(`EXTENSOES_ANEXO[^\\n]+[\"']${extensao}[\"']`),
      `falta suporte a .${extensao}`);
  });
  assert.match(api, /validarAnexo\(arquivo\)/, "a API precisa validar antes do upload");
  assert.match(api, /MAXIMO_ANEXOS[^\n]+5/);
  assert.match(api, /config\.uploadMaxMb \|\| 10/);
  assert.match(api, /client\.rpc\("flow_register_attachment"/,
    "o navegador não deve inserir metadados sem as validações atômicas do banco");
  assert.match(api, /remove\(\[caminho\]\)/, "falha no registro não pode deixar arquivo órfão");

  const solicitar = fs.readFileSync(path.join(root, "flow_solicitar.js"), "utf8");
  assert.match(solicitar, /blocos\.push\(montarAnexos\(\)\)/,
    "anexos precisam aparecer mesmo em tipos que não usam documentos");
  assert.match(solicitar, /accept: Api\.anexos\.accept/);
  assert.match(solicitar, /estado\.anexos\.length \+ aceitos\.length >= maximo/,
    "a seleção precisa parar no quinto arquivo");
  assert.match(solicitar, /Tentar anexos novamente/,
    "uma falha precisa ser visível e permitir nova tentativa");
  assert.doesNotMatch(solicitar, /anexo não enviado[^\n]+console\.warn/,
    "falha de anexo não pode ficar somente no console");
  const migration = fs.readFileSync(path.join(root, "database/migrations/flow_19_attachment_guardrails.sql"), "utf8");
  assert.match(migration, /public = false/);
  assert.match(migration, /file_size_limit = 10485760/);
  assert.match(migration, /macroenabled\.12/i, "o bucket precisa aceitar Excel com macro");
  assert.match(migration, /Limite de 5 anexos por solicitação atingido/);
  assert.match(migration, /for update/i, "uploads simultâneos precisam ser serializados por solicitação");
  assert.match(migration, /revoke insert, update, delete/i,
    "metadados não podem contornar o RPC validado");
  assert.doesNotMatch(migration, /delete\s+from\s+storage\.objects/i,
    "objetos do Storage nunca devem ser apagados diretamente por SQL");
});

check("o painel mostra o consumo total e o peso dos anexos", () => {
  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");
  const painel = fs.readFileSync(path.join(root, "flow_painel.js"), "utf8");
  const migration = fs.readFileSync(path.join(root, "database/migrations/flow_19_attachment_guardrails.sql"), "utf8");
  assert.match(api, /client\.rpc\("flow_storage_usage"\)/);
  assert.match(painel, /id: "painel-armazenamento"/);
  assert.match(painel, /Anexos:/);
  assert.match(painel, /role: "progressbar"/);
  assert.match(migration, /auth\.uid\(\) is null or not public\.flow_is_staff\(\)/i);
  assert.match(migration, /grant execute on function public\.flow_storage_usage\(\) to authenticated/i);
});

check("o painel baixa o anexo privado mantendo o nome original", () => {
  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");
  assert.match(api, /async linkDownload\(caminho, nomeArquivo\)/);
  assert.match(api, /createSignedUrl\(caminho, 300, \{/);
  assert.match(api, /download: texto\(nomeArquivo\) \|\| true/);
  const painel = fs.readFileSync(path.join(root, "flow_painel.js"), "utf8");
  assert.match(painel, /text: "Baixar"/);
  assert.match(painel, /Api\.anexos\.linkDownload/);
  assert.match(painel, /download: anexo\.file_name/);
});

check("a exclusão remove anexos antes da solicitação e fica restrita a administradores", () => {
  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");
  const remocaoStorage = api.indexOf('client.storage.from("flow-anexos").remove(caminhos)');
  const remocaoBanco = api.indexOf('client.rpc("flow_delete_request"');
  assert.ok(remocaoStorage > -1, "os objetos precisam ser removidos pelo Storage API");
  assert.ok(remocaoBanco > remocaoStorage, "o banco só deve ser apagado depois dos objetos");
  assert.match(api, /client\.storage\.from\("flow-anexos"\)\.list\(pasta/,
    "a exclusão precisa descobrir e remover também um eventual objeto sem metadados");
  assert.match(api, /if \(!auth\.ehAdmin\(\)\)/, "a interface de dados precisa bloquear operador e solicitante");

  const migration = fs.readFileSync(path.join(root, "database/migrations/flow_18_secure_request_deletion.sql"), "utf8");
  assert.match(migration, /security definer/i);
  assert.match(migration, /auth\.uid\(\)/i);
  assert.match(migration, /flow_is_admin\(\)/i);
  assert.match(migration, /revoke all on function public\.flow_delete_request\(uuid\)/i);
  assert.match(migration, /grant execute on function public\.flow_delete_request\(uuid\) to authenticated/i);
});

check("o painel exige o protocolo e confirmação antes da exclusão permanente", () => {
  const painel = fs.readFileSync(path.join(root, "flow_painel.js"), "utf8");
  assert.match(painel, /text: "Excluir solicitação"/);
  assert.match(painel, /Api\.auth\.ehAdmin\(\)/);
  assert.match(painel, /root\.prompt\(/);
  assert.match(painel, /Ui\.confirmar\(`Excluir permanentemente/);
  assert.match(painel, /Api\.solicitacoes\.excluir\(solicitacao\.id, solicitacao\.anexos \|\| \[\]\)/);
});

check("a listagem de LDs informa a relação histórica sem ambiguidade", () => {
  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");
  assert.match(api, /versoes:flow_ld_versions!flow_ld_versions_ld_id_fkey\(/,
    "sem a FK explícita o PostgREST responde 300 porque current_version_id cria uma segunda relação");
});

check("a configuração publicada não carrega chave secreta", () => {
  const config = fs.readFileSync(path.join(root, "flow_config.js"), "utf8");
  assert.doesNotMatch(config, /sb_secret_/, "chave secreta jamais vai para o navegador");
  assert.doesNotMatch(config, /service_role/, "service_role ignora a RLS e não pode ser publicada");
  assert.match(config, /supabaseUrl/);
  assert.match(config, /https:\/\/[a-z0-9]+\.supabase\.co/);
});

console.log(JSON.stringify({ app: "GRCON Flow", passou: true, testes: checks.length, nomes: checks }, null, 2));
