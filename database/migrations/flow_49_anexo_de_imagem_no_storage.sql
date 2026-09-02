-- GRCON Flow 49 — a policy do Storage passa a aceitar anexo de imagem.
-- Aplicada no projeto em 20260902220240.
--
-- A flow_32 abriu imagem em quatro lugares: `storage.buckets.allowed_mime_types`,
-- a constraint de extensão de `flow_attachments`, a constraint de MIME e o
-- `flow_register_attachment`. Ficou de fora justamente a guarda que roda
-- primeiro — a policy de INSERT em `storage.objects` —, e por isso enviar um
-- `.jpg` falhava com violação de RLS antes de chegar a qualquer uma das outras.
--
-- Esta migração só amplia o que é aceito. Nenhum anexo já gravado muda.

begin;

drop policy if exists "flow anexos envio" on storage.objects;

create policy "flow anexos envio"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'flow-anexos'
  and public.flow_attachment_request_from_path(name) is not null
  and public.flow_can_see_request(public.flow_attachment_request_from_path(name))
  and public.flow_attachment_slots_available(public.flow_attachment_request_from_path(name))
  and lower(substring(name from '\.([^.]+)$')) = any (array[
    'pdf', 'xls', 'xlsx', 'xlsm', 'doc', 'docx', 'dwg',
    'jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'
  ]::text[])
);

commit;

-- Conferência depois de aplicar: a lista abaixo precisa devolver as treze
-- extensões, e não sete.
--
--   select with_check from pg_policies
--    where schemaname = 'storage' and tablename = 'objects'
--      and policyname = 'flow anexos envio';
