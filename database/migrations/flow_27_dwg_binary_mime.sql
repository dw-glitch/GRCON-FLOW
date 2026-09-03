-- Exportada de supabase_migrations.schema_migrations em 03/09/2026.
-- Versão aplicada: 20260825123126.
--
-- Este arquivo é o SQL que de fato criou os objetos no projeto — não uma
-- reconstrução a partir do schema. Ele estava aplicado no banco mas nunca
-- havia sido versionado, o que impedia montar uma instalação nova (ou um
-- ambiente de homologação) a partir do repositório.
--
-- Não edite para corrigir comportamento: uma migração já aplicada é
-- histórico. Mudança de regra entra numa migração nova.

alter table public.flow_attachments drop constraint if exists flow_attachments_mime_valid;
alter table public.flow_attachments add constraint flow_attachments_mime_valid
check (mime_type in (
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.macroenabled.12',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/acad',
  'application/dwg',
  'application/x-dwg',
  'image/vnd.dwg',
  'application/octet-stream'
));

update storage.buckets
   set allowed_mime_types = array[
     'application/pdf',
     'application/vnd.ms-excel',
     'application/vnd.ms-excel.sheet.macroenabled.12',
     'application/vnd.ms-excel.sheet.macroEnabled.12',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     'application/msword',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/acad',
     'application/dwg',
     'application/x-dwg',
     'image/vnd.dwg',
     'application/octet-stream'
   ]
 where id = 'flow-anexos';
