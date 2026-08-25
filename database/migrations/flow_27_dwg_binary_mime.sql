-- GRCON Flow 27 — DWG pode chegar do navegador como binário genérico.
-- A extensão .dwg continua obrigatória pela policy e pela constraint, portanto
-- aceitar application/octet-stream não libera outros tipos de arquivo.

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
