-- GRCON Flow — índices dos caminhos que crescem com a operação.
--
-- A auditoria do Supabase identificou estas FKs sem cobertura. São justamente
-- as usadas para abrir a caixa recente, validar o par de anexos de um item e
-- limpar a fonte normativa quando uma norma é excluída.

begin;

create index if not exists flow_notifications_user_recent_idx
  on public.flow_notifications (user_id, created_at desc);

create index if not exists flow_notifications_request_idx
  on public.flow_notifications (request_id)
  where request_id is not null;

create index if not exists flow_attachments_item_idx
  on public.flow_attachments (item_id)
  where item_id is not null;

create index if not exists flow_norm_catalog_source_version_idx
  on public.flow_norm_catalog_entries (source_norm_version_id)
  where source_norm_version_id is not null;

commit;
