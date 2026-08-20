-- GRCON Flow — entrega de anexos da solicitação.
--
-- A interface aceita PDF, Excel e Word. O bucket já era privado e já aceitava
-- PDF, XLS/XLSX e DOC/DOCX; esta migração completa o suporte a XLSM sem retirar
-- os tipos anteriormente usados pelo Flow.

update storage.buckets
set public = false,
    file_size_limit = 26214400,
    allowed_mime_types = case
      when allowed_mime_types is null then array[
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
        'application/vnd.ms-excel.sheet.macroenabled.12',
        'application/vnd.ms-excel.sheet.macroEnabled.12',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/msword'
      ]::text[]
      else array(
        select distinct mime
        from unnest(allowed_mime_types || array[
          'application/vnd.ms-excel.sheet.macroenabled.12',
          'application/vnd.ms-excel.sheet.macroEnabled.12'
        ]::text[]) as mime
      )
    end
where id = 'flow-anexos';

