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
// flow_ui.js só toca no DOM dentro das funções; carregá-lo aqui permite
// exercitar o vocabulário compartilhado em vez de conferi-lo por regex.
await import(`file://${path.join(root, "flow_ui.js")}`);

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
    "PROTOCOLO", "PRIORIDADE", "TIPO", "ORIGEM", "SOLICITANTE", "RECEBIDA",
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

check("a exportação filtrada cobre o recorte inteiro, não a página na tela", () => {
  // Com paginação, exportar o que está desenhado entregaria 50 de 312 sem avisar.
  // A garantia de não divergir é as duas pontas passarem pelo mesmo montador de
  // filtros — na tela e na camada de dados.
  const painel = fs.readFileSync(path.join(root, "flow_painel.js"), "utf8");
  assert.match(painel, /Api\.solicitacoes\.protocolos\(filtrosDaConsulta\(\)\)/);
  assert.match(painel, /filtros\.limite = estado\.porPagina/,
    "a listagem usa o mesmo recorte, só que paginado");
  assert.doesNotMatch(painel, /filtros\.protocolos = estado\.solicitacoes\.map/,
    "exportar a página visível volta a ser uma armadilha silenciosa");

  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");
  const usos = api.match(/aplicarFiltrosDeSolicitacao\(consulta, filtros\)/g) || [];
  assert.equal(usos.length, 2, "listar e protocolos precisam aplicar os mesmos filtros");
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
  assert.match(home, /aoMudar\(\(sessao, perfil\) => \{[\s\S]*?if \(sessao && perfil\) encaminhar\(\);/);
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
  assert.match(painel, /\{ chave: "acesso", rotulo: "Acesso",[^}]*admin: true \}/);
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
  assert.match(painel, /\{ chave: "normas", rotulo: "Normas e códigos",[^}]*admin: true \}/);
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
    "o contador não pode depender apenas das notificações exibidas");
  assert.match(api, /async marcarTodasLidas\(\)/);
  assert.match(api, /async excluir\(id\)/);
  assert.match(api, /async excluirTodas\(\)/);
  assert.match(api, /flow_notifications"\)\.delete\(\)/,
    "a exclusão deve passar pelo cliente autenticado e pela RLS");
  assert.match(api, /limit\(50\)/,
    "a caixa deve manter também o histórico recente já lido");
  assert.match(api, /\.eq\("user_id", state\.session\.user\.id\)\.is\("read_at", null\)/,
    "a consulta deve ser explicitamente limitada ao usuário conectado");

  const painel = fs.readFileSync(path.join(root, "flow_painel.js"), "utf8");
  assert.match(painel, /id: "painel-notificacoes-botao"/);
  assert.match(painel, /id: "painel-notificacoes-menu"/);
  assert.match(painel, /abrirNotificacao\(notificacao\)/,
    "clicar no alerta deve abrir diretamente a solicitação relacionada");
  assert.match(painel, /Api\.notificacoes\.marcarLida\(notificacao\.id\)/);
  assert.match(painel, /Api\.notificacoes\.marcarTodasLidas\(\)/);
  assert.match(painel, /Api\.notificacoes\.excluir\(notificacao\.id\)/);
  assert.match(painel, /Api\.notificacoes\.excluirTodas\(\)/);
  assert.match(painel, /INTERVALO_NOTIFICACOES_MS = 60000/,
    "o tempo real precisa de uma conferência leve como contingência");
  assert.match(painel, /estado\.notificacoes\.slice\(0, 50\)/,
    "o tempo real deve conservar o mesmo limite do histórico carregado");
  assert.match(painel, /visibilitychange/,
    "ao voltar para o painel, as notificações devem ser conferidas sem recarregar a página");
  assert.match(painel, /carregarNotificacoes\(\)/,
    "a caixa precisa recuperar avisos perdidos enquanto a pessoa estava fora do painel");
  assert.match(painel, /evento\.composedPath\(\)\.includes\(central\)/,
    "redesenhar o conteúdo do botão não pode fechar a caixa no mesmo clique");

  const migration = fs.readFileSync(path.join(root, "database/migrations/flow_20_notification_inbox_controls.sql"), "utf8");
  assert.match(migration, /for delete\s+to authenticated\s+using \(\(select auth\.uid\(\)\) = user_id\)/i,
    "cada destinatário só pode excluir as próprias notificações");
  assert.match(migration, /revoke all privileges[^\n]+from anon/i);
  assert.match(migration, /grant select, update, delete[^\n]+to authenticated/i);
  assert.doesNotMatch(migration, /grant insert[^\n]+to authenticated/i,
    "avisos continuam sendo criados apenas pelo gatilho do banco");
});

check("todo tipo de solicitação aceita até trinta anexos de documento, DWG ou imagem", () => {
  // O contrato do formulário é o mesmo do banco (migrações flow_25 a flow_32).
  // Quando as duas pontas discordam, o arquivo sobe e o registro é recusado — o
  // pior dos dois mundos, porque o solicitante já acha que anexou.
  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");
  // A lista virou duas constantes (documento + imagem); a asserção lê o bloco
  // inteiro em vez de uma linha, para não quebrar quando ela for reformatada.
  const bloco = api.match(/const EXTENSOES_IMAGEM[\s\S]*?const ACEITE_ANEXO/);
  assert.ok(bloco, "as listas de extensão precisam existir");
  ["pdf", "xls", "xlsx", "xlsm", "doc", "docx", "dwg",
   "jpg", "jpeg", "png", "webp", "heic", "heif"].forEach((extensao) => {
    assert.ok(bloco[0].includes(`"${extensao}"`), `falta suporte a .${extensao}`);
  });
  assert.match(api, /validarAnexo\(arquivo\)/, "a API precisa validar antes do upload");
  assert.match(api, /TETO_ANEXOS = 30/);
  assert.match(api, /MAXIMO_ANEXOS = Math\.min\(TETO_ANEXOS/);
  assert.match(api, /dwg: "application\/acad"/, "o MIME do DWG precisa ser um dos aceitos pelo bucket");
  assert.match(api, /config\.uploadMaxMb \|\| 10/);
  assert.match(api, /client\.rpc\("flow_register_attachment"/,
    "o navegador não deve inserir metadados sem as validações atômicas do banco");
  assert.match(api, /remove\(\[caminho\]\)/, "falha no registro não pode deixar arquivo órfão");

  const solicitar = fs.readFileSync(path.join(root, "flow_solicitar.js"), "utf8");
  assert.match(solicitar, /blocos\.push\(montarAnexos\(\)\)/,
    "anexos precisam aparecer mesmo em tipos que não usam documentos");
  assert.match(solicitar, /accept: Api\.anexos\.accept/);
  assert.match(solicitar, /estado\.anexos\.length \+ aceitos\.length >= maximo/,
    "a seleção precisa parar no limite de arquivos");
  assert.match(solicitar, /Tentar anexos novamente/,
    "uma falha precisa ser visível e permitir nova tentativa");
  assert.doesNotMatch(solicitar, /anexo não enviado[^\n]+console\.warn/,
    "falha de anexo não pode ficar somente no console");
  const migration = fs.readFileSync(path.join(root, "database/migrations/flow_19_attachment_guardrails.sql"), "utf8");
  assert.match(migration, /public = false/);
  assert.match(migration, /file_size_limit = 10485760/);
  assert.match(migration, /macroenabled\.12/i, "o bucket precisa aceitar Excel com macro");
  const limites = fs.readFileSync(path.join(root, "database/migrations/flow_25_triage_requester_dwg_limits.sql"), "utf8");
  assert.match(limites, /Limite de 30 anexos complementares por solicitação/,
    "o teto do banco é o mesmo anunciado na tela");
  assert.match(limites, /'pdf','xls','xlsx','xlsm','doc','docx','dwg'/,
    "as extensões do banco e da tela precisam coincidir");
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
  assert.match(painel, /exigirTexto: protocolo/, "a exclusão só libera quem digitar o protocolo");
  assert.match(painel, /perigo: true/);
  assert.match(painel, /Api\.solicitacoes\.excluir\(solicitacao\.id, solicitacao\.anexos \|\| \[\]\)/);
});

// ── Perguntas são da aplicação, não do navegador ───────────────────────────

const ARQUIVOS_DO_APP = fs.readdirSync(root)
  .filter((nome) => /^flow_[a-z_]+\.js$/.test(nome) && nome !== "flow_config.js");

check("nenhuma pergunta sai pelo diálogo nativo do navegador", () => {
  // `confirm` e `prompt` travam a aba, ignoram o tema, não cabem em telas
  // pequenas e não sabem dizer o que está sendo apagado.
  ARQUIVOS_DO_APP.forEach((nome) => {
    const fonte = fs.readFileSync(path.join(root, nome), "utf8");
    assert.doesNotMatch(fonte, /\b(root|window)\.(confirm|prompt)\(/, `${nome} ainda usa diálogo nativo`);
  });
  const ui = fs.readFileSync(path.join(root, "flow_ui.js"), "utf8");
  assert.match(ui, /return new Promise\(\(resolver\) => \{/, "a confirmação passou a ser assíncrona");
});

check("toda confirmação é esperada com await", () => {
  // Sem `await`, o valor testado é a promessa — sempre verdadeira — e a ação
  // destrutiva seguiria adiante como se alguém tivesse confirmado.
  ARQUIVOS_DO_APP.forEach((nome) => {
    const fonte = fs.readFileSync(path.join(root, nome), "utf8");
    for (const achado of fonte.matchAll(/(.{0,8})Ui\.confirmar\(/g)) {
      assert.ok(achado[1].endsWith("await "), `${nome}: confirmação sem await — "${achado[0]}"`);
    }
  });
});

check("a caixa não leva embora a tela que está atrás dela", () => {
  const ui = fs.readFileSync(path.join(root, "flow_ui.js"), "utf8");
  assert.match(ui, /evento\.stopPropagation\(\);\s*\n\s*fechar\(\);/,
    "o Escape precisa morrer na caixa: a ficha e a caixa de notificações também o escutam");
  assert.match(ui, /if \(typeof aoFechar === "function"\) aoFechar\(\);/,
    "sair pelo Escape, pelo fundo ou pelo X precisa responder como um cancelar");
});

check("o botão é guardado antes de perguntar", () => {
  // `currentTarget` é anulado quando o manipulador cede a vez. Com a caixa
  // assíncrona, lê-lo depois do await devolveria null e quebraria o estado de
  // "Excluindo…".
  const painel = fs.readFileSync(path.join(root, "flow_painel.js"), "utf8");
  for (const trecho of painel.split(/onclick: async \(evento\) => \{/).slice(1)) {
    const corpo = trecho.slice(0, 900);
    const usoDoBotao = corpo.indexOf("evento.currentTarget");
    const primeiroAwait = corpo.indexOf("await ");
    if (usoDoBotao < 0 || primeiroAwait < 0) continue;
    assert.ok(usoDoBotao < primeiroAwait,
      "currentTarget precisa ser lido antes do primeiro await do manipulador");
  }
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

// ── O que já foi digitado não se perde ─────────────────────────────────────

check("acrescentar documento ou anexo não apaga o formulário já preenchido", () => {
  // Cada `render()` reconstrói a etapa 2 a partir do estado. Se o que está na
  // tela não for copiado para lá antes, adicionar um documento devolve o nome do
  // perfil por cima do que a pessoa acabou de escrever.
  const solicitar = fs.readFileSync(path.join(root, "flow_solicitar.js"), "utf8");
  assert.match(solicitar, /if \(estado\.etapa === 2\) guardarFormulario\(\);/,
    "render precisa capturar o formulário antes de redesenhar");
  assert.match(solicitar, /function guardarFormulario\(\) \{\s*\n\s*if \(!estado\.tipo \|\| !document\.getElementById\("sol-nome"\)\) return;/,
    "e não pode explodir quando o formulário ainda não está na tela");
  assert.match(solicitar, /const foco = marcarFoco\(\);[\s\S]*?devolverFoco\(foco\);/,
    "o cursor precisa voltar para onde estava depois do redesenho");
});

// ── Recuperação de senha ───────────────────────────────────────────────────

check("o link de recuperação leva a uma tela de nova senha", () => {
  // Sem esta parada, o link autenticava a pessoa e o roteador a mandava adiante
  // com a senha antiga: um "entrar" disfarçado de "recuperar".
  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");
  assert.match(api, /type=recovery/, "o rastro precisa ser lido antes de createClient limpar a URL");
  assert.match(api, /evento === "PASSWORD_RECOVERY"/, "o evento do supabase-js também marca a recuperação");
  assert.match(api, /get recuperandoSenha\(\)/);

  const home = fs.readFileSync(path.join(root, "flow_home.js"), "utf8");
  assert.match(home, /Api\.auth\.recuperandoSenha/);
  assert.match(home, /render\("redefinir"\)/);
  assert.match(home, /Api\.auth\.definirSenha\(valorSenha\)/,
    "a tela precisa mesmo trocar a senha, não só existir");
  assert.match(home, /Api\.auth\.concluiuRecuperacao\(\)/);
});

// ── Perfil ─────────────────────────────────────────────────────────────────

check("cada pessoa corrige os próprios dados sem depender do administrador", () => {
  const ui = fs.readFileSync(path.join(root, "flow_ui.js"), "utf8");
  assert.match(ui, /function abrirPerfil/);
  assert.match(ui, /Api\.auth\.atualizarPerfil\(\{/, "o perfil precisa ser gravado de fato");
  assert.match(ui, /Api\.auth\.definirSenha\(nova\)/);
  assert.match(ui, /class: "flow-user-botao"/, "o acesso fica no nome, na barra do topo");
  assert.match(ui, /abrirModal, abrirPerfil/, "e é exportado para as três telas");

  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");
  assert.match(api, /client\.rpc\("flow_update_my_profile"/);
  const migration = fs.readFileSync(path.join(root, "database/migrations/flow_14_secure_owner_and_permissions.sql"), "utf8");
  assert.match(migration, /function public\.flow_update_my_profile/,
    "a tela só pode chamar o que existe no banco");
});

check("a caixa modal devolve o foco e prende o Tab", () => {
  const ui = fs.readFileSync(path.join(root, "flow_ui.js"), "utf8");
  assert.match(ui, /const anterior = doc\.activeElement;/);
  assert.match(ui, /anterior\.focus\(\)/, "fechar precisa devolver o foco de onde veio");
  assert.match(ui, /evento\.key !== "Tab"/, "o Tab não pode escapar para a página de trás");
  assert.match(ui, /p1-modal-open/, "a página de trás não rola junto");
});

// ── Painel ─────────────────────────────────────────────────────────────────

check("a aba do painel vive no endereço e o título acompanha", () => {
  const painel = fs.readFileSync(path.join(root, "flow_painel.js"), "utf8");
  assert.match(painel, /function abaDaUrl/);
  assert.match(painel, /conhecida\.admin && !Api\.auth\.ehAdmin\(\)/,
    "uma aba de administrador no endereço não pode abrir para operador");
  assert.match(painel, /history\.(pushState|replaceState)/);
  assert.match(painel, /addEventListener\("popstate"/, "voltar pelo navegador precisa funcionar");
  assert.match(painel, /id: "painel-titulo"/);
});

check("alteração em lote vai até o fim e diz o que falhou", () => {
  const painel = fs.readFileSync(path.join(root, "flow_painel.js"), "utf8");
  assert.match(painel, /falhas\.push\(\{ id, erro: erroDoItem \}\)/,
    "o primeiro erro não pode abortar o restante em silêncio");
  assert.match(painel, /falhas\.forEach\(\(falha\) => restantes\.set\(falha\.id/,
    "o que falhou continua selecionado para a próxima tentativa");
  assert.match(painel, /botao\.disabled = true;/, "o botão trava enquanto o lote roda");
  assert.match(painel, /Aplicando \$\{indice \+ 1\} de/, "o progresso precisa ser visível");
});

check("a ficha trava o botão enquanto salva e devolve o foco ao fechar", () => {
  const painel = fs.readFileSync(path.join(root, "flow_painel.js"), "utf8");
  assert.match(painel, /botaoSalvar\.disabled = true;/,
    "duplo clique não pode gravar a mesma alteração duas vezes");
  assert.match(painel, /function fecharGaveta/);
  assert.match(painel, /focoAntesDaFicha/, "fechar a ficha devolve o foco ao protocolo que a abriu");
  assert.match(painel, /document\.body\.classList\.add\("p1-modal-open"\)/);
});

check("o painel pagina de verdade, com total vindo do servidor", () => {
  const painel = fs.readFileSync(path.join(root, "flow_painel.js"), "utf8");
  assert.match(painel, /filtros\.inicio = \(estado\.pagina - 1\) \* estado\.porPagina/);
  assert.match(painel, /estado\.total = Number\(total\) \|\| 0/,
    "o total é do recorte inteiro, não do que veio na página");
  assert.match(painel, /Mostrando \$\{primeira/);
  assert.match(painel, /function irParaPagina/);
  assert.match(painel, /if \(!manterPagina\) estado\.pagina = 1;/,
    "trocar filtro precisa voltar para a primeira página");

  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");
  assert.match(api, /\{ count: "exact" \}/, "sem contagem exata não há número de páginas");
  assert.match(api, /async function chamarComTotal/);
});

check("todo filtro do painel é aplicado no servidor", () => {
  // Peneirar no navegador depois de trazer as linhas só funcionava porque a tela
  // trazia tudo: numa página de 50, "atrasadas" mostraria as atrasadas das 50
  // primeiras — e o total no rodapé seria ficção.
  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");
  assert.match(api, /if \(filtros\.atrasadas\)/);
  assert.match(api, /if \(filtros\.semResponsavel\)/);
  assert.match(api, /filtro_itens:flow_request_items!inner\(id\)/,
    "a classificação vive no item; o inner join traz a solicitação sem repetir a linha");
  assert.match(api, /eq\("filtro_itens\.classification", filtros\.classificacao\)/);

  const painel = fs.readFileSync(path.join(root, "flow_painel.js"), "utf8");
  assert.doesNotMatch(painel, /estado\.solicitacoes = estado\.solicitacoes\.filter/,
    "nenhum recorte pode voltar a ser feito depois da consulta");
});

check("ordenar por coluna vai ao servidor e é determinístico", () => {
  // Ordenar só a página desenhada responderia "as mais antigas destas 50", não
  // as mais antigas da base — e nada na tela denunciaria a diferença.
  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");
  assert.match(api, /const ORDENS_DE_SOLICITACAO = Object\.freeze\(/,
    "o nome da coluna entra na consulta: precisa vir de lista fechada");
  assert.doesNotMatch(api, /ORDENS_DE_SOLICITACAO\[[^\]]*\]\s*\|\|\s*ordem/,
    "coluna desconhecida cai no padrão, nunca no que a tela mandou");
  assert.match(api, /if \(coluna !== "protocol"\) ordenada = ordenada\.order\("protocol"/,
    "sem desempate único, a mesma linha pode cair em duas páginas ou em nenhuma");
  assert.match(api, /nullsFirst: false/, "quem não tem prazo vai para o fim nos dois sentidos");

  const painel = fs.readFileSync(path.join(root, "flow_painel.js"), "utf8");
  assert.match(painel, /filtros\.ordem = estado\.ordem;/);
  assert.match(painel, /function ordenarPor/);
  assert.match(painel, /ascendente: ativa \? !estado\.ordem\.ascendente : Boolean\(ordem\.ascendentePrimeiro\)/,
    "repetir a coluna inverte; trocar de coluna usa o sentido natural do dado");
  assert.match(painel, /"aria-sort": sentido/, "leitor de tela precisa saber por onde a tabela está ordenada");
});

check("progresso não finge uma ordem que não tem", () => {
  // "2 de 2" e "2 de 10" não se comparam por items_done; a coluna não oferece
  // ordenação em vez de oferecer uma errada.
  const painel = fs.readFileSync(path.join(root, "flow_painel.js"), "utf8");
  assert.match(painel, /\{ coluna: "owner_name", ascendentePrimeiro: true \},\s*\n\s*null,/,
    "a posição do progresso na lista de ordens precisa ser nula");
  assert.match(painel, /if \(!coluna\.ordem\) return elemento\("th", \{ text: coluna\.rotulo \}\);/);
  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");
  assert.doesNotMatch(api, /items_done:/, "items_done não pode virar chave de ordenação");
});

check("a seleção atravessa páginas sem perder o protocolo", () => {
  const painel = fs.readFileSync(path.join(root, "flow_painel.js"), "utf8");
  assert.match(painel, /selecionadas: new Map\(\)/,
    "só o id não basta: a exportação precisa do protocolo de linhas que saíram da tela");
  assert.match(painel, /estado\.selecionadas\.set\(solicitacao\.id, solicitacao\.protocol\)/);
  assert.match(painel, /\[\.\.\.estado\.selecionadas\.values\(\)\]/);
  assert.doesNotMatch(painel, /estado\.selecionadas = new Set\(/,
    "trocar de página não pode zerar o que já estava marcado");
});

check("o solicitante abre o próprio pedido sem copiar o protocolo à mão", () => {
  const acompanhar = fs.readFileSync(path.join(root, "flow_acompanhar.js"), "utf8");
  assert.match(acompanhar, /class: "flow-protocolo-link"/);
  assert.match(acompanhar, /const abrirProtocolo = \(protocolo\) =>/);
  assert.match(acompanhar, /cartaoSolicitacao\(solicitacao, abrirProtocolo\)/);
});

// ── Ajustes operacionais moram nos módulos, não num remendo ────────────────

check("não há patch de runtime remendando a API e o DOM depois de carregados", () => {
  // O arquivo antigo trocava métodos de FlowApi e reescrevia textos da tela por
  // regex, num MutationObserver permanente sobre o documento inteiro. As regras
  // que ele carregava agora nascem nos próprios módulos.
  assert.equal(fs.existsSync(path.join(root, "flow_runtime_patch.js")), false);
  ["solicitar.html", "painel.html", "index.html", "acompanhar.html"].forEach((pagina) => {
    const html = fs.readFileSync(path.join(root, pagina), "utf8");
    assert.doesNotMatch(html, /flow_runtime_patch/, `${pagina} ainda carrega o remendo`);
  });
  const ui = fs.readFileSync(path.join(root, "flow_ui.js"), "utf8");
  assert.match(ui, /rotulo: "JÁ EXISTE · alocado"/, "o vocabulário do painel é do módulo");
  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");
  assert.match(api, /triadasNoServidor/, "a triagem já feita no banco não se repete pela tela");
});

// ── Alocação: a LD tem três respostas, não duas ────────────────────────────

check("alocação confirmada sem código não é dita como ausência de alocação", () => {
  // A LD pode afirmar ALOCADO sem trazer o código da GRDT — 379 linhas das LDs
  // vigentes estão assim. A triagem já distingue o caso (o resumo dela diz
  // "com alocação (confirmada)"); eram as telas que colapsavam isso em "sem
  // alocação identificada", contando o oposto do que a base diz.
  const Ui = janela.FlowUi;
  assert.equal(Ui.situacaoAlocacao({ allocation: "C1O-ALOC-CM-0042-2025" }).estado, "identificada");
  assert.equal(Ui.situacaoAlocacao({ allocation: "", allocation_status: "ALOCADO" }).estado, "confirmada");
  assert.equal(Ui.situacaoAlocacao({ allocation: "", allocation_status: "NÃO ALOCADO" }).estado, "ausente");
  assert.equal(Ui.situacaoAlocacao({ allocation: "", allocation_status: "" }).estado, "ausente");
  assert.equal(Ui.situacaoAlocacao({}).estado, "ausente");
  // Tipo sem LD não afirma nada sobre alocação: não procuramos.
  assert.equal(Ui.situacaoAlocacao({ allocation: "", classification: "TRIAGEM_NAO_APLICAVEL" }).estado,
    "nao-aplicavel");
});

check("“NÃO ALOCADO” não é confundido com “ALOCADO”", () => {
  // Um teste por substring inverteria justamente o caso que importa: o rótulo
  // negativo contém o positivo.
  const Ui = janela.FlowUi;
  ["NÃO ALOCADO", "não alocado", "  NÃO   ALOCADO  "].forEach((status) => {
    assert.equal(Ui.situacaoAlocacao({ allocation: "", allocation_status: status }).estado, "ausente",
      `"${status}" não pode virar alocação confirmada`);
  });
  assert.equal(Ui.situacaoAlocacao({ allocation: "", allocation_status: " alocado " }).estado, "confirmada");
});

check("as duas telas usam a mesma leitura da alocação", () => {
  const painel = fs.readFileSync(path.join(root, "flow_painel.js"), "utf8");
  const acompanhar = fs.readFileSync(path.join(root, "flow_acompanhar.js"), "utf8");
  assert.match(painel, /Ui\.situacaoAlocacao\(item\)/);
  assert.match(acompanhar, /root\.FlowUi\.situacaoAlocacao\(item\)/);
  assert.doesNotMatch(painel, /text: "Sem alocação identificada"/,
    "o rótulo precisa vir do auxiliar, para as telas não divergirem");
  // A frase "sem alocação identificada" continua válida — no ramo em que a LD
  // de fato não aloca. O que não pode voltar é a decisão sair do campo sozinho.
  assert.match(acompanhar, /alocacao\.estado === "confirmada"/);
  [painel, acompanhar].forEach((fonte) => {
    assert.doesNotMatch(fonte, /texto\(item\.allocation\)/,
      "a tela não decide mais pela presença do código; quem decide é o auxiliar");
  });
});

// ── Triagem de tipo que não consulta LD ────────────────────────────────────

check("a triagem roda mesmo quando o tipo não consulta LD", () => {
  // `flow_triage_item` sempre soube gravar TRIAGEM_NAO_APLICAVEL; a criação é
  // que protegia a chamada com `if tipo.uses_ld then` e nunca a alcançava.
  const migracao = fs.readFileSync(
    path.join(root, "database/migrations/flow_27_triagem_sem_ld.sql"), "utf8");
  assert.match(migracao, /create or replace function public\.flow_create_request/);
  // O comentário do cabeçalho cita a condição para explicar o que saiu; a
  // conferência é sobre o código, não sobre a prosa.
  const codigo = migracao.split("\n").filter((linha) => !linha.trimStart().startsWith("--")).join("\n");
  assert.doesNotMatch(codigo, /if tipo\.uses_ld then/,
    "a condição que impedia a triagem precisa sair");
  assert.match(migracao, /triagem_resultado := public\.flow_triage_request\(nova_solicitacao\)/);
  assert.match(migracao, /exception when others then/,
    "a solicitação continua não se perdendo por falha de triagem");
  assert.match(migracao, /classification = 'TRIAGEM_NAO_APLICAVEL'/,
    "o que já está gravado precisa ser corrigido");
  assert.match(migracao, /and not t\.uses_ld/,
    "o reparo não pode alcançar itens de tipos que usam LD");

  // A classificação existe no vocabulário da interface desde sempre; agora ela
  // finalmente chega lá.
  const ui = fs.readFileSync(path.join(root, "flow_ui.js"), "utf8");
  assert.match(ui, /TRIAGEM_NAO_APLICAVEL: Object\.freeze\(\{ rotulo: "Triagem não aplicável"/);
});

// ── Urgência ───────────────────────────────────────────────────────────────

check("imagem é anexo válido nos quatro portões", () => {
  // São quatro lugares que precisam concordar; passar num e falhar no seguinte
  // deixa o arquivo órfão no bucket ou o erro sem explicação na tela.
  const migracao = fs.readFileSync(
    path.join(root, "database/migrations/flow_32_anexo_de_imagem.sql"), "utf8"
  );
  ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].forEach((mime) => {
    assert.ok(migracao.includes(`'${mime}'`), `o bucket precisa aceitar ${mime}`);
  });
  assert.match(migracao, /'jpg','jpeg','png','webp','heic','heif'/,
    "a restrição de extensão precisa listar as imagens");
  assert.match(migracao, /when 'jpg'\s+then mime_type = any/,
    "a restrição de MIME confere por extensão");
  assert.match(migracao, /'jpg','jpeg','png','webp','heic','heif'\) then\s*\n\s*raise exception 'Formato de anexo não permitido/,
    "o RPC de registro precisa aceitar as mesmas extensões");

  // E a tela precisa oferecer exatamente o que o banco aceita.
  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");
  const lista = api.match(/const EXTENSOES_IMAGEM = Object\.freeze\(\[([^\]]*)\]\)/);
  assert.ok(lista, "EXTENSOES_IMAGEM precisa existir");
  ["jpg", "jpeg", "png", "webp", "heic", "heif"].forEach((ext) => {
    assert.ok(lista[1].includes(`"${ext}"`), `a tela precisa oferecer .${ext}`);
  });
});

check("o conjunto obrigatório da N-1710 continua recusando imagem", () => {
  // A regra é do contrato: LI/MC exige PDF e Excel do mesmo documento. Abrir
  // para imagem aqui deixaria a solicitação concluir sem a representação que a
  // norma pede.
  const migracao = fs.readFileSync(
    path.join(root, "database/migrations/flow_32_anexo_de_imagem.sql"), "utf8"
  );
  assert.match(
    migracao,
    /if extension not in \('pdf','xls','xlsx','xlsm'\) then\s*\n\s*raise exception 'LI\/MC da N-1710/,
    "o ramo LI/MC não pode ganhar formatos novos"
  );
});

check("foto grande é reduzida antes de ser recusada, e só então", () => {
  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");

  // A redução é último recurso: abaixo do limite o original sobe intacto,
  // porque o canvas descarta o EXIF — data, orientação e coordenada da foto.
  const preparar = api.match(/async function prepararAnexo\(arquivo\) \{[\s\S]*?\n  \}/);
  assert.ok(preparar, "prepararAnexo precisa existir");
  assert.match(preparar[0], /if \(arquivo\.size <= limiteDeBytes\(\)\) return \{ arquivo, error: null \}/,
    "arquivo dentro do limite não pode passar pelo canvas");
  assert.match(preparar[0], /ehImagem\(arquivo\) \? await reduzirImagem\(arquivo\) : null/,
    "só imagem é reduzida; documento grande continua recusado");

  // A orientação do EXIF precisa ser aplicada, senão a foto chega deitada.
  assert.match(api, /imageOrientation: "from-image"/);
  // E o nome tem que acompanhar o formato real, senão a restrição de MIME recusa.
  assert.match(api, /\.replace\(\/\\\.\[\^\.\]\+\$\/, ""\)\}\.jpg/,
    "o arquivo reduzido vira .jpg e o nome precisa dizer isso");

  // E o envio precisa usar o preparo, não a validação antiga.
  assert.match(api, /const preparado = await prepararAnexo\(arquivoOriginal\)/);
});

check("a tela pública consegue explicar a recusa por tamanho", () => {
  // flow_solicitar_public.js só deixa passar mensagem que casa com um padrão
  // seguro; sem o padrão do tamanho, o solicitante veria "não foi possível
  // enviar" sem saber que a foto é grande demais.
  const publico = fs.readFileSync(path.join(root, "flow_solicitar_public.js"), "utf8");
  assert.match(publico, /\/tem mais de \\d\+ MB\/i/,
    "a mensagem de tamanho precisa ser considerada segura para o solicitante");

  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");
  assert.match(api, /tem mais de \$\{config\.uploadMaxMb \|\| 10\} MB/,
    "a mensagem do cliente precisa casar com o padrão da tela pública");
});

check("o solicitante não é notificado; a equipe continua sendo", () => {
  // Decisão do cliente: quem precisa ser avisado é o executor da atividade — a
  // equipe de qualidade —, pelo canal do Teams. O solicitante não recebe nada.
  const migracao = fs.readFileSync(
    path.join(root, "database/migrations/flow_33_sem_aviso_ao_solicitante.sql"), "utf8"
  );
  const corpo = migracao.match(
    /create or replace function public\.flow_update_request\([\s\S]*?\n\$\$;/
  );
  assert.ok(corpo, "a função precisa ser recriada na migração");
  assert.ok(
    !corpo[0].includes("flow_notifications"),
    "alterar a solicitação não pode mais gerar aviso ao solicitante"
  );

  // E o que a decisão quer manter tem que continuar de pé: o aviso à equipe no
  // registro vem de flow_notify_new_request, que esta migração não toca.
  assert.ok(
    !migracao.includes("create or replace function public.flow_notify_new_request"),
    "o aviso à equipe no registro não pode ser alterado por esta migração"
  );

  // A trava do par PDF+Excel e o histórico continuam dentro da função: remover
  // o aviso não pode ter levado junto o resto do corpo.
  assert.match(corpo[0], /LI\/MC da N-1710 sem o conjunto PDF \+ Excel/,
    "a regra do contrato precisa continuar na função");
  assert.match(corpo[0], /'solicitacao_alterada', p_field/,
    "o histórico precisa continuar sendo gravado");
});


check("a família normativa em SQL não diverge da regra do core.js", () => {
  // Há duas implementações da mesma regra: core.js valida a codificação na
  // importação da LD, e a flow_31 responde no banco, que é quem escreve o item.
  // O precedente é flow_is_n1710_li_mc (flow_24). O que impede divergência é
  // este teste: ele lê as duas e compara os literais que decidem a família.
  const core = fs.readFileSync(path.join(root, "core.js"), "utf8");
  const migracao = fs.readFileSync(
    path.join(root, "database/migrations/flow_31_familia_normativa.sql"), "utf8"
  );

  // O core.js decide ET em validateDocumentCode por conter "_RNEST_" — e não
  // pelo regex estrito de isEtDocument, que reprova ET mal codificado.
  assert.match(core, /sheet === "ET" \|\| raw\.includes\("_RNEST_"\)/,
    "se o core.js mudar o teste de ET, a flow_31 precisa mudar junto");
  assert.match(migracao, /valor like '%\\_RNEST\\_%' then 'ET'/,
    "o SQL precisa usar o mesmo teste frouxo de _RNEST_");

  // O regex de currículo, caractere a caractere.
  const cv = core.match(/const CV_DOCUMENT_RE = \/\^(.+?)\$\/i;/);
  assert.ok(cv, "CV_DOCUMENT_RE precisa existir em core.js");
  assert.ok(
    migracao.includes(`^${cv[1]}$`),
    `o regex de CV do SQL precisa ser o mesmo do core.js: ^${cv[1]}$`
  );

  // A ordem dos ramos importa: ET antes de CV antes de N-1710.
  const iEt = migracao.indexOf("then 'ET'");
  const iCv = migracao.indexOf("then 'CV'");
  const iN = migracao.indexOf("else 'N-1710'");
  assert.ok(iEt > 0 && iEt < iCv && iCv < iN, "a ordem dos ramos deve seguir validateDocumentCode");
});

check("a família fica vazia quando não há código, e é restrita no banco", () => {
  const migracao = fs.readFileSync(
    path.join(root, "database/migrations/flow_31_familia_normativa.sql"), "utf8"
  );
  assert.match(migracao, /check \(norm_family in \('', 'N-1710', 'ET', 'CV'\)\)/);
  assert.match(migracao, /when coalesce\(btrim\(valor\), ''\) = '' then ''/,
    "título solto não tem norma que o reja — não pode virar N-1710 por omissão");

  // O gatilho que já preparava o item é quem preenche, do mesmo código.
  assert.match(migracao, /new\.norm_family := public\.flow_document_family\(new\.document\)/);

  // O backfill não passa pelo gatilho de propósito: ele recalcula seis campos e
  // levantaria a exceção do par PDF+Excel em item já concluído.
  assert.match(migracao, /update public\.flow_request_items\s*\n\s*set norm_family =/,
    "o backfill deve escrever a coluna direto");

  const Ui = janela.FlowUi;
  assert.deepEqual(Object.keys(Ui.FAMILIAS_NORMATIVAS), ["N-1710", "ET", "CV"]);
  assert.equal(Ui.seloFamilia(""), null, "sem código, sem selo");
  assert.equal(Ui.seloFamilia("INVENTADA"), null, "valor fora da lista não vira selo");
});

check("a família é sigla e sem cor própria", () => {
  // O código de cores da folha do cliente tem três entradas, todas em uso.
  // Uma quarta paleta aqui competiria com as que já carregam significado.
  const ui = fs.readFileSync(path.join(root, "flow_ui.js"), "utf8");
  const bloco = ui.match(/function seloFamilia\(valor\) \{[\s\S]*?\n  \}/);
  assert.ok(bloco, "seloFamilia precisa existir");
  assert.match(bloco[0], /class: "flow-selo neutro"/,
    "a família usa o selo neutro; cor é reservada a urgência e origem");

  const css = fs.readFileSync(path.join(root, "flow.css"), "utf8");
  assert.ok(!/\.flow-selo\.familia-/.test(css), "não deve haver paleta própria para a família");

  // E a sigla é o texto do selo, não o nome da norma por extenso.
  assert.match(bloco[0], /text: chave/);
});

check("a NORMA entra na aba de itens e não no Controle Oficial", () => {
  const headers = Export.COLUNAS_ITENS.map((coluna) => coluna.header);
  assert.ok(headers.includes("NORMA"), "a aba de itens precisa da coluna");
  assert.ok(
    !Report.CONTROL_COLUMNS.some((coluna) => /^NORMA$/i.test(String(coluna).trim())),
    "o Controle Oficial tem as 26 colunas da planilha do cliente"
  );
  assert.equal(Report.CONTROL_COLUMNS.length, 26);
});


check("cabeçalho, ordenação e célula da lista andam no mesmo índice", () => {
  // O painel monta os cabeçalhos a partir de COLUNAS_PAINEL e as ordenações a
  // partir de uma lista paralela, casadas por posição. Acrescentar uma coluna
  // no Excel sem acrescentar a ordenação correspondente desloca todas as
  // seguintes: clicar em "Status" passaria a ordenar por prazo, calado.
  const painel = fs.readFileSync(path.join(root, "flow_painel.js"), "utf8");
  const bloco = painel.match(/const ORDENS_DA_LISTA = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.ok(bloco, "ORDENS_DA_LISTA precisa existir");
  const entradas = bloco[1].split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.startsWith("{ coluna:") || linha === "null,");
  assert.equal(
    entradas.length, Export.COLUNAS_PAINEL.length,
    "cada coluna do painel precisa de uma entrada de ordenação, mesmo que null"
  );

  // E a linha precisa desenhar o mesmo número de células.
  const corpo = painel.match(/const linha = elemento\("tr", \{ class: classes \}, \[([\s\S]*?)\n      \]\);/);
  assert.ok(corpo, "a montagem da linha precisa existir");
  const celulas = (corpo[1].match(/^        elemento\("td"/gm) || []).length;
  assert.equal(
    celulas, Export.COLUNAS_PAINEL.length + 1,
    "a linha tem uma célula por coluna, mais a caixa de seleção"
  );
});

check("a origem é agregada pelo banco, não adivinhada pela tela", () => {
  // O painel lista solicitações; a presença em LD é do item. Derivar a origem
  // no navegador só funcionaria com todos os itens carregados — e a lista é
  // paginada no servidor. Fora isso, coluna derivada no cliente não ordena e
  // não filtra sem mentir no total do rodapé.
  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");
  assert.match(api, /origin: "origin"/, "origem precisa ser coluna ordenável no servidor");
  assert.match(api, /if \(filtros\.origem\) consulta = consulta\.eq\("origin", filtros\.origem\)/);
  assert.match(api, /consulta\.eq\("request_origin", filtros\.origem\)/,
    "a exportação precisa recortar pelo mesmo filtro da tela");

  const painel = fs.readFileSync(path.join(root, "flow_painel.js"), "utf8");
  assert.match(painel, /Ui\.seloOrigem\(solicitacao\.origin\)/);
  assert.match(painel, /id: "filtro-origem"/);
  assert.match(painel, /if \(f\.origem\) filtros\.origem = f\.origem;/,
    "o filtro escolhido na tela precisa chegar à consulta");
});

check("o vocabulário da origem é o mesmo que o banco aceita", () => {
  const Ui = janela.FlowUi;
  const migracao = fs.readFileSync(
    path.join(root, "database/migrations/flow_30_origem_novo_ou_previsto.sql"), "utf8"
  );
  // A tela não pode oferecer um valor que a restrição do banco recusa.
  Object.keys(Ui.ORIGENS).forEach((valor) => {
    assert.ok(
      new RegExp(`'${valor}'`).test(migracao),
      `a origem "${valor}" precisa constar da restrição da flow_30`
    );
  });
  assert.match(migracao, /check \(origin in \('', 'novo', 'previsto', 'misto', 'a_confirmar', 'nao_aplicavel'\)\)/);

  // A presença no item vem da flow_25 e não pode ser reinventada aqui.
  const flow25 = fs.readFileSync(
    path.join(root, "database/migrations/flow_25_triage_requester_dwg_limits.sql"), "utf8"
  );
  Object.keys(Ui.PRESENCAS_EM_LD).forEach((valor) => {
    assert.ok(
      new RegExp(`'${valor}'`).test(flow25),
      `a presença "${valor}" precisa ser um valor real de ld_presence_status`
    );
  });
});

check("o gatilho do agregado ouve as colunas que a triagem escreve", () => {
  // Sem isto o agregado nasce certo no registro e congela: a triagem escreve
  // classification e ld_presence_status, nunca status.
  const migracao = fs.readFileSync(
    path.join(root, "database/migrations/flow_30_origem_novo_ou_previsto.sql"), "utf8"
  );
  assert.match(
    migracao,
    /after insert or delete or update of status, classification, ld_presence_status/,
    "o gatilho precisa disparar também nas colunas da triagem"
  );
  assert.match(migracao, /perform public\.flow_refresh_request_progress\(alvo\)/,
    "o backfill deve usar a mesma função do gatilho, e não uma regra paralela");
});

check("a origem sai por extenso na planilha e não entra no Controle Oficial", () => {
  const exportacao = fs.readFileSync(path.join(root, "flow_export.js"), "utf8");
  assert.match(exportacao, /nao_aplicavel: ""/,
    "o tipo que não consulta LD não escreve nada na coluna");
  assert.match(exportacao, /previsto: "JÁ PREVISTO"/);
  assert.ok(
    !Report.CONTROL_COLUMNS.some((coluna) => /ORIGEM/i.test(String(coluna))),
    "o Controle Oficial tem as 26 colunas da planilha do cliente, e ORIGEM não é uma delas"
  );
});


check("o solicitante consegue marcar o próprio pedido como urgente", () => {
  // flow_update_request recusa quem não é da equipe, e o papel padrão de todo
  // cadastro novo é 'solicitante'. Marcar urgência por ela deixaria a caixa do
  // formulário funcionando só para administradores — o resto perderia a
  // urgência calada. Daí um RPC que abre exatamente um campo, e só para o dono.
  const solicitar = fs.readFileSync(path.join(root, "flow_solicitar.js"), "utf8");
  assert.doesNotMatch(
    solicitar, /Api\.solicitacoes\.atualizar\(/,
    "a tela pública não pode passar por flow_update_request, que é da equipe"
  );

  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");
  assert.match(api, /flow_set_request_priority/);

  const migracao = fs.readFileSync(
    path.join(root, "database/migrations/flow_28_prioridade_da_solicitacao.sql"), "utf8"
  );
  assert.match(migracao, /create or replace function public\.flow_set_request_priority/);
  assert.match(migracao, /p_priority not in \('baixa', 'normal', 'alta', 'urgente'\)/,
    "o RPC precisa validar o valor, e não confiar só na restrição da coluna");
  assert.match(migracao, /submitted_by_id, atual\.requester_id\) is distinct from auth\.uid\(\)/,
    "fora da equipe, só o dono do pedido");
  assert.match(migracao, /grant execute on function public\.flow_set_request_priority/);
});

check("o RPC de prioridade não fica exposto ao papel anônimo", () => {
  // O Supabase concede execute a anon por privilégio padrão quando a função
  // nasce em public, e `revoke from public` não alcança concessão nominal a
  // papel. Sem a revogação explícita, esta seria a única das 57 funções flow_*
  // com anon na ACL. A trava de auth.uid() já barra a chamada; isto é a lista
  // de permissões concordando com o que a função faz.
  const migracoes = fs.readdirSync(path.join(root, "database/migrations"))
    .filter((nome) => nome.endsWith(".sql"))
    .map((nome) => fs.readFileSync(path.join(root, "database/migrations", nome), "utf8"))
    .join("\n");
  assert.match(
    migracoes,
    /revoke execute on function public\.flow_set_request_priority\(uuid, text, text\) from anon/,
    "falta revogar execute de anon no RPC de prioridade"
  );
});

check("a tela pública não mostra detalhe técnico ao solicitante", () => {
  // flow_solicitar_public.js existe para manter erro de SQL/RLS fora dos olhos
  // de quem só quer registrar um pedido. Um aviso novo não pode furar isso.
  const solicitar = fs.readFileSync(path.join(root, "flow_solicitar.js"), "utf8");
  const vazamentos = solicitar.match(/avisar\(`[^`]*\$\{[^}]*\.error[^}]*\}[^`]*`/g) || [];
  assert.deepEqual(
    vazamentos, [],
    `mensagem de erro cru na tela do solicitante: ${vazamentos.join(" | ")}`
  );
});

check("normal não ganha selo; alta e urgente sim", () => {
  // Se toda linha carrega um selo, nenhuma chama atenção. O que se destaca é o
  // que sai do normal — é isso que impede "urgente" de virar decoração.
  const Ui = janela.FlowUi;
  assert.equal(Ui.seloPrioridade("normal"), null);
  assert.equal(Ui.seloPrioridade(""), null);
  assert.equal(Ui.seloPrioridade(undefined), null);
  assert.ok(Ui.seloPrioridade("urgente"), "urgente precisa de selo");
  assert.ok(Ui.seloPrioridade("alta"), "alta precisa de selo");
  assert.equal(Ui.prioridadeEmDestaque("urgente"), true);
  assert.equal(Ui.prioridadeEmDestaque("alta"), true);
  assert.equal(Ui.prioridadeEmDestaque("normal"), false);
  assert.equal(Ui.prioridadeEmDestaque("baixa"), false);
  assert.equal(Ui.rotuloPrioridade("urgente"), "Urgente");
});

check("o vocabulário da tela é o mesmo que o banco aceita", () => {
  // Quatro valores, nem um a mais: a coluna passou a ter restrição, então um
  // rótulo inventado na tela viraria erro de gravação na cara do usuário.
  const Ui = janela.FlowUi;
  assert.deepEqual(Object.keys(Ui.PRIORIDADES), ["baixa", "normal", "alta", "urgente"]);
  assert.equal(Ui.PRIORIDADE_PADRAO, "normal");

  const migracao = fs.readFileSync(
    path.join(root, "database/migrations/flow_28_prioridade_da_solicitacao.sql"), "utf8");
  assert.match(migracao, /check \(priority in \('baixa', 'normal', 'alta', 'urgente'\)\)/);
  assert.match(migracao, /update public\.flow_requests[\s\S]*?set priority = 'normal'/,
    "valor fora da lista precisa ser normalizado antes da restrição entrar");
});

check("a urgência é gravada como ato explícito, com autor e horário", () => {
  // Passar prioridade como parâmetro do registro esconderia quem pediu
  // prioridade. Como alteração, ela nasce no histórico.
  const solicitar = fs.readFileSync(path.join(root, "flow_solicitar.js"), "utf8");
  assert.match(solicitar, /Api\.solicitacoes\.definirPrioridade\(\s*\n?\s*data\.id, "urgente"/);
  assert.match(solicitar, /Marcada como urgente pelo solicitante no registro/);
  assert.match(solicitar, /id: "sol-urgente"/);

  const painel = fs.readFileSync(path.join(root, "flow_painel.js"), "utf8");
  assert.match(painel, /\["priority", prioridade\.value/,
    "a ficha precisa salvar a prioridade junto das demais alterações");
});

check("o painel destaca, filtra, conta e ordena por urgência", () => {
  const painel = fs.readFileSync(path.join(root, "flow_painel.js"), "utf8");
  assert.match(painel, /chave: "urgentesAbertas"/, "o cartão de indicador precisa existir");
  assert.match(painel, /id: "filtro-prioridade"/);
  assert.match(painel, /\{ coluna: "priority", ascendentePrimeiro: false \}/,
    "o primeiro clique deve trazer os urgentes, não a ordem alfabética");
  assert.match(painel, /destaque \? `urgente-\$\{texto\(solicitacao\.priority\)\}` : ""/);
  assert.match(painel, /!\["concluido", "cancelado"\]\.includes\(solicitacao\.status\)/,
    "urgência de pedido fechado não é fila de trabalho");

  const api = fs.readFileSync(path.join(root, "flow_api.js"), "utf8");
  assert.match(api, /if \(filtros\.urgentes\)/);
  assert.match(api, /\.in\("priority", \["alta", "urgente"\]\)/);
  assert.match(api, /priority: "priority"/, "prioridade precisa ser coluna ordenável no servidor");
});

check("a cor não é o único recado da urgência", () => {
  // Quem não distingue vermelho precisa ler a palavra. A faixa reforça; o selo
  // e a coluna informam.
  const css = fs.readFileSync(path.join(root, "flow.css"), "utf8");
  assert.match(css, /\.flow-selo\.prioridade-urgente/);
  assert.match(css, /tr\.urgente-urgente td:first-child/);
  const exportacao = fs.readFileSync(path.join(root, "flow_export.js"), "utf8");
  assert.match(exportacao, /urgente: "URGENTE"/, "a planilha precisa dizer por extenso");
  assert.match(exportacao, /normal: ""/, "e deixar o normal em branco");
});

check("o Controle Oficial continua com as mesmas 26 colunas", () => {
  // A prioridade entra na Visão do Painel, nunca na aba que é colada sob a
  // planilha oficial do cliente.
  const colunas = Report.CONTROL_COLUMNS || Report.controlColumns;
  const cabecalhos = (colunas || []).map((c) => (typeof c === "string" ? c : c.header));
  assert.equal(cabecalhos.length, 26, "a planilha oficial tem 26 colunas");
  assert.ok(!cabecalhos.some((c) => /PRIORIDADE/i.test(String(c))),
    "prioridade não pode aparecer no Controle Oficial");
});

console.log(JSON.stringify({ app: "GRCON Flow", passou: true, testes: checks.length, nomes: checks }, null, 2));
