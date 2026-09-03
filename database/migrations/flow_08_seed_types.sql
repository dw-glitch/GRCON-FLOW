-- Exportada de supabase_migrations.schema_migrations em 03/09/2026.
-- Versão aplicada: 20260819205936.
--
-- Este arquivo é o SQL que de fato criou os objetos no projeto — não uma
-- reconstrução a partir do schema. Ele estava aplicado no banco mas nunca
-- havia sido versionado, o que impedia montar uma instalação nova (ou um
-- ambiente de homologação) a partir do repositório.
--
-- Não edite para corrigir comportamento: uma migração já aplicada é
-- histórico. Mudança de regra entra numa migração nova.

-- GRCON Flow — semente dos tipos de solicitação.
-- Tudo aqui é DADO, não regra fixa no código: o administrador altera rótulo,
-- campos, prazo, fluxo e comportamento pela própria tela.

insert into public.flow_request_types (
  code, label, description, icon, display_order,
  uses_ld, requires_document, allows_documents, allows_multiple, title_search,
  not_found_is_expected, default_deadline_days, default_priority, panel_columns, answer_required
) values
('POSTAGEM_SIGEM','Postagem no SIGEM',
 'Postar um ou mais documentos no SIGEM.','upload',1,
 true, true, true, true, false, false, 3, 'normal',
 '["document","official_title","allocation","sigem_status","classification"]'::jsonb, false),

('ALOCACAO','Alocação',
 'Providenciar a alocação de documentos.','alocacao',2,
 true, true, true, true, false, false, 7, 'alta',
 '["document","official_title","allocation","allocation_status","classification"]'::jsonb, false),

('INCLUSAO_LD','Inclusão na LD',
 'Incluir um documento que ainda não consta na Lista de Documentos.','mais',3,
 true, false, true, true, true, true, 10, 'normal',
 '["document","requested_title","ld_name","classification"]'::jsonb, false),

('INCLUSAO_E_ALOCACAO','Inclusão na LD + Alocação',
 'Incluir na LD e, na sequência, providenciar a alocação.','mais',4,
 true, false, true, true, true, true, 10, 'alta',
 '["document","requested_title","allocation","classification"]'::jsonb, false),

('ALTERACAO_TITULO','Alteração de título',
 'Corrigir ou alterar o título oficial de um documento.','texto',5,
 true, false, true, true, true, false, 5, 'normal',
 '["document","official_title","classification"]'::jsonb, false),

('CORRECAO_ALOCACAO','Correção de alocação',
 'Corrigir a alocação registrada para um documento.','ajuste',6,
 true, true, true, true, false, false, 5, 'normal',
 '["document","allocation","allocation_status","classification"]'::jsonb, false),

('CORRECAO_LD','Correção da LD',
 'Corrigir uma informação cadastrada na Lista de Documentos.','ajuste',7,
 true, false, true, true, true, false, 5, 'normal',
 '["document","official_title","ld_name","classification"]'::jsonb, false),

('INCLUSAO_CV','Inclusão de CV',
 'Incluir currículo de profissional na Lista de Documentos.','pessoa',8,
 true, false, true, true, false, true, 5, 'normal',
 '["document","requested_title","classification"]'::jsonb, false),

('IMPRESSAO','Impressão',
 'Solicitar impressão de documentos.','impressora',9,
 false, false, true, true, false, false, 2, 'normal',
 '["document","requested_title"]'::jsonb, false),

('LOCALIZAR_CODIGO','Localizar código pelo título',
 'Você sabe o nome do documento, mas não o código.','busca',10,
 true, false, false, false, true, false, 3, 'normal',
 '["requested_title","document","classification"]'::jsonb, true),

('CONSULTA_INFO','Consulta / Solicitação de informação',
 'Perguntar sobre alocação, revisão, GRDT, status ou qualquer outra informação documental.','pergunta',11,
 true, false, false, false, true, false, 3, 'normal',
 '["reference","classification"]'::jsonb, true)

on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Campos dinâmicos.
-- Solicitante, área, contato, documentos, observação e anexos são partes fixas
-- do formulário. Aqui ficam apenas as perguntas próprias de cada tipo — é o
-- que faz o formulário mudar de verdade quando o usuário troca o serviço.
-- ---------------------------------------------------------------------------
insert into public.flow_type_fields (type_id, field_key, label, help, placeholder, field_kind, options, required, display_order)
select t.id, f.field_key, f.label, f.help, f.placeholder, f.field_kind, f.options, f.required, f.display_order
from public.flow_request_types t
join (values
  -- Inclusão na LD
  ('INCLUSAO_LD','titulo_documento','Título do documento','Se você não tem o código, o título já basta para registrarmos.','Relatório de Inspeção da Válvula X','text','[]'::jsonb,false,1),
  ('INCLUSAO_LD','justificativa','Por que precisa ser incluído?','','Contrato aditivo, novo escopo, exigência da fiscalização…','textarea','[]'::jsonb,true,2),

  ('INCLUSAO_E_ALOCACAO','titulo_documento','Título do documento','Se você não tem o código, o título já basta.','','text','[]'::jsonb,false,1),
  ('INCLUSAO_E_ALOCACAO','justificativa','Por que precisa ser incluído?','','','textarea','[]'::jsonb,true,2),

  -- Alteração de título
  ('ALTERACAO_TITULO','titulo_atual','Título atual','Como está hoje, se você souber.','','text','[]'::jsonb,false,1),
  ('ALTERACAO_TITULO','titulo_solicitado','Título solicitado','Como deve passar a constar.','','text','[]'::jsonb,true,2),
  ('ALTERACAO_TITULO','justificativa','Justificativa','','','textarea','[]'::jsonb,false,3),

  -- Correção de alocação
  ('CORRECAO_ALOCACAO','alocacao_atual','Alocação registrada hoje','','C1O-ALOC-CM-0000-2026','text','[]'::jsonb,false,1),
  ('CORRECAO_ALOCACAO','alocacao_correta','Alocação correta','Se você souber qual deveria ser.','','text','[]'::jsonb,false,2),
  ('CORRECAO_ALOCACAO','justificativa','O que está errado?','','','textarea','[]'::jsonb,true,3),

  -- Correção da LD
  ('CORRECAO_LD','o_que_corrigir','O que precisa ser corrigido na LD?','Revisão, título, disciplina, formato, situação…','','textarea','[]'::jsonb,true,1),

  -- Inclusão de CV
  ('INCLUSAO_CV','nome_profissional','Nome do profissional','','','text','[]'::jsonb,true,1),
  ('INCLUSAO_CV','funcao','Função / cargo','','','text','[]'::jsonb,false,2),
  ('INCLUSAO_CV','justificativa','Observações','','','textarea','[]'::jsonb,false,3),

  -- Impressão
  ('IMPRESSAO','quantidade','Quantidade de cópias','','1','number','[]'::jsonb,true,1),
  ('IMPRESSAO','formato','Formato','','','select','["A4","A3","A2","A1","A0"]'::jsonb,true,2),
  ('IMPRESSAO','cor','Impressão','','','select','["Preto e branco","Colorida"]'::jsonb,false,3),
  ('IMPRESSAO','local_entrega','Local de entrega','Onde devemos entregar as cópias.','','text','[]'::jsonb,true,4),
  ('IMPRESSAO','prazo_desejado','Precisa até','','','date','[]'::jsonb,false,5),

  -- Localizar código pelo título
  ('LOCALIZAR_CODIGO','titulo_documento','Título do documento','Escreva o nome como você o conhece. Vamos procurar nas LDs vigentes.','Relatório de Inspeção da Válvula X','text','[]'::jsonb,true,1),
  ('LOCALIZAR_CODIGO','informacao_adicional','Alguma outra referência?','TAG, disciplina, contrato, pasta — qualquer coisa que ajude a achar.','','textarea','[]'::jsonb,false,2),

  -- Consulta de informação
  ('CONSULTA_INFO','pergunta','O que você precisa saber?','','Qual é a alocação deste documento? Qual foi a última GRDT?','textarea','[]'::jsonb,true,1),
  ('CONSULTA_INFO','referencia','Sobre qual documento?','Código, título, TAG ou uma descrição. O que você tiver.','','text','[]'::jsonb,false,2)
) as f(type_code, field_key, label, help, placeholder, field_kind, options, required, display_order)
  on f.type_code = t.code
on conflict (type_id, field_key) do nothing;

-- Configurações gerais iniciais.
insert into public.flow_settings (key, value) values
  ('app', '{"nome":"GRCON Flow","protocolo_prefixo":"FLOW"}'::jsonb),
  ('anexos', '{"tamanho_maximo_mb":25,"extensoes":["pdf","xlsx","xls","xlsm","docx","doc","png","jpg","jpeg","zip","msg","txt","csv"]}'::jsonb)
on conflict (key) do nothing;
