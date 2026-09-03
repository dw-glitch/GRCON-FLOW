# Ordem real de aplicação das migrações

Gerado de `supabase_migrations.schema_migrations` em 03/09/2026.

**O nome do arquivo não é a ordem.** A ordem é a coluna `version`, e ela diverge
da ordenação alfabética em alguns pontos — `flow_29_triagem_sem_ld` foi aplicada
depois de `flow_28_attachment_upload_and_dwg_mime_fix`, mas o arquivo dela no
repositório chama-se `flow_27_triagem_sem_ld.sql` e ordenaria antes. Para montar
um banco novo, siga esta tabela, não o `ls`.

## Aplicadas no projeto

| # | Versão | Nome aplicado | Arquivo no repositório | Observação |
| --- | --- | --- | --- | --- |
| 1 | `20260819205246` | `flow_01_profiles_and_roles` | `flow_01_profiles_and_roles.sql` |  |
| 2 | `20260819205307` | `flow_02_request_types_and_fields` | `flow_02_request_types_and_fields.sql` |  |
| 3 | `20260819205346` | `flow_03_requests_items_history` | `flow_03_requests_items_history.sql` |  |
| 4 | `20260819205414` | `flow_04_rls_requests` | `flow_04_rls_requests.sql` |  |
| 5 | `20260819205455` | `flow_05_ld_base` | `flow_05_ld_base.sql` |  |
| 6 | `20260819205737` | `flow_06_triage_engine` | `flow_06_triage_engine.sql` |  |
| 7 | `20260819205828` | `flow_07_operations_and_storage` | `flow_07_operations_and_storage.sql` |  |
| 8 | `20260819205936` | `flow_08_seed_types` | `flow_08_seed_types.sql` |  |
| 9 | `20260819210101` | `flow_09_hardening` | `flow_09_hardening.sql` |  |
| 10 | `20260820101306` | `flow_10_acesso` | `flow_10_acesso.sql` |  |
| 11 | `20260820101331` | `flow_11_espelho_allowlist` | `flow_11_espelho_allowlist.sql` |  |
| 12 | `20260820171332` | `flow_12_safe_ld_import` | `flow_12_safe_ld_import.sql` |  |
| 13 | `20260820171348` | `flow_13_versioned_norms` | `flow_13_versioned_norms.sql` |  |
| 14 | `20260820171402` | `flow_14_secure_owner_and_permissions` | `flow_14_secure_owner_and_permissions.sql` |  |
| 15 | `20260820171535` | `flow_15_seed_norm_versions` | `flow_15_seed_norm_versions.sql` |  |
| 16 | `20260820180247` | `flow_16_norm_sources_and_files` | `flow_16_norm_sources_and_files.sql` |  |
| 17 | `20260820192138` | `flow_17_request_attachments` | `flow_17_request_attachments.sql` |  |
| 18 | `20260820221526` | `flow_18_secure_request_deletion` | `flow_18_secure_request_deletion.sql` |  |
| 19 | `20260821101529` | `flow_19_attachment_guardrails` | `flow_19_attachment_guardrails.sql` |  |
| 20 | `20260821131810` | `flow_20_notification_inbox_controls` | `flow_20_notification_inbox_controls.sql` |  |
| 21 | `20260821224601` | `unified_sigem_workflow` | `flow_21_unified_sigem_workflow.sql` | nome divergente do aplicado |
| 22 | `20260821233110` | `live_storage_metrics` | `flow_22_live_storage_metrics.sql` | nome divergente do aplicado |
| 23 | `20260822170846` | `owner_storage_visibility` | `flow_23_owner_storage_visibility.sql` | nome divergente do aplicado |
| 24 | `20260824101625` | `n1710_li_mc_pdf_excel_pair` | `flow_24_n1710_li_mc_pdf_excel_pair.sql` | nome divergente do aplicado |
| 25 | `20260824213818` | `flow_25_triage_requester_dwg_limits` | `flow_25_triage_requester_dwg_limits.sql` |  |
| 26 | `20260824214035` | `flow_26_tracking_ld_result` | `flow_26_tracking_ld_result.sql` |  |
| 27 | `20260825115207` | `flow_27_attachment_upload_and_dwg_mime_fix` | `flow_27_attachment_upload_and_dwg_mime_fix.sql` |  |
| 28 | `20260825123126` | `flow_27_dwg_binary_mime` | `flow_27_dwg_binary_mime.sql` |  |
| 29 | `20260825123411` | `flow_28_attachment_upload_and_dwg_mime_fix` | `flow_28_attachment_upload_and_dwg_mime_fix.sql` |  |
| 30 | `20260825123552` | `flow_29_triagem_sem_ld` | `flow_27_triagem_sem_ld.sql` | nome divergente do aplicado |
| 31 | `20260827093554` | `flow_35_resilient_request_registration` | `flow_35_resilient_request_registration.sql` |  |
| 32 | `20260827094828` | `flow_36_attachment_capacity_and_assignment_notification` | `flow_36_attachment_capacity_and_assignment_notification.sql` |  |
| 33 | `20260827094836` | `flow_37_owner_norm_deletion` | `flow_37_owner_norm_deletion.sql` |  |
| 34 | `20260827095035` | `flow_38_operational_indexes` | `flow_38_operational_indexes.sql` |  |
| 35 | `20260827171351` | `flow_39_teams_assignment_notification` | `flow_39_teams_assignment_notification.sql` |  |
| 36 | `20260828133231` | `flow_40_staff_quick_registration` | `flow_40_staff_quick_registration.sql` |  |
| 37 | `20260828175535` | `flow_41_quick_registration_phase_2` | `flow_41_quick_registration_phase_2.sql` |  |
| 38 | `20260828175719` | `flow_42_quick_template_type_index` | `flow_42_quick_template_type_index.sql` |  |
| 39 | `20260828185741` | `flow_43_external_inbox_phase_3` | — | removida do repositório — ver `git show 0dfddb7^:database/migrations/flow_43_external_inbox_phase_3.sql` |
| 40 | `20260828185904` | `flow_44_external_inbox_review_index` | — | removida do repositório — ver `git show 0dfddb7^:database/migrations/flow_44_external_inbox_review_index.sql` |
| 41 | `20260828231256` | `flow_45_admin_request_owner` | `flow_45_admin_request_owner.sql` |  |
| 42 | `20260831104835` | `flow_46_outlook_local_bridge` | — | removida do repositório — ver `git show 0dfddb7^:database/migrations/flow_46_outlook_local_bridge.sql` |
| 43 | `20260831105011` | `flow_47_outlook_bridge_created_by_index` | — | removida do repositório — ver `git show 0dfddb7^:database/migrations/flow_47_outlook_bridge_created_by_index.sql` |
| 44 | `20260901195219` | `flow_46_triagem_normativa_e_protocolos` | `flow_46_triagem_normativa_e_protocolos.sql` |  |
| 45 | `20260901195506` | `flow_48_protocol_adjustment_hardening` | `flow_48_protocol_adjustment_hardening.sql` |  |
| 46 | `20260902220240` | `flow_49_anexo_de_imagem_no_storage` | `flow_49_anexo_de_imagem_no_storage.sql` |  |
| 47 | `20260902220308` | `flow_51_protocolo_fuso_teto_e_auditoria` | `flow_51_protocolo_fuso_teto_e_auditoria.sql` |  |
| 48 | `20260902220429` | `flow_50_triagem_normativa_e_idempotencia_do_outlook` | `flow_50_triagem_normativa_e_idempotencia_do_outlook.sql` |  |
| 49 | `20260902220503` | `flow_52_limpeza_da_fase_3` | `flow_52_limpeza_da_fase_3.sql` |  |

## Arquivos do repositório sem registro de aplicação

Estas migrações estão no repositório e seus objetos existem no banco, mas foram
aplicadas pelo SQL Editor sem passar pelo controle de versões do Supabase — por
isso não aparecem em `schema_migrations`. Elas fazem parte do caminho de
instalação e devem ser executadas na posição indicada pelo número do arquivo.

- `flow_28_prioridade_da_solicitacao.sql`
- `flow_29_prioridade_sem_anon.sql`
- `flow_30_origem_novo_ou_previsto.sql`
- `flow_31_familia_normativa.sql`
- `flow_32_anexo_de_imagem.sql`
- `flow_33_sem_aviso_ao_solicitante.sql`
- `flow_34_responsavel_e_pessoa.sql`

## Migrações da Fase 3

`flow_43`, `flow_44`, `flow_46_outlook_local_bridge` e `flow_47` criaram a caixa
de entrada externa por webhook e a ponte local em PowerShell. As duas foram
descartadas pela política corporativa e removidas do projeto no commit
`0dfddb7`; o `flow_52` remove do banco o que elas deixaram.

Os arquivos **não voltam** para o repositório de propósito: numa instalação nova
esses objetos nunca chegam a existir, e o `flow_52` foi escrito para não ter o
que remover nesse caso. O SQL original continua recuperável pelo histórico do
git, e o registro delas em `schema_migrations` **não deve ser apagado** — é o que
explica por que aqueles objetos existiram.
