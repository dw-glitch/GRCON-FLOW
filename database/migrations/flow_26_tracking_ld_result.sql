-- GRCON Flow 26 — acompanhamento preserva resultado da triagem e o par LI/MC.
create or replace function public.flow_track_protocol(p_protocol text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r record;
  itens jsonb;
begin
  select * into r from public.flow_requests where protocol = upper(trim(p_protocol));
  if not found then return null; end if;
  if not (r.requester_id = auth.uid() or r.submitted_by_id = auth.uid() or public.flow_is_staff()) then
    raise exception 'Este protocolo não pertence à sua conta.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'item_number', i.item_number,
      'document', i.document,
      'requested_title', i.requested_title,
      'status', i.status,
      'answer', i.answer,
      'ld_presence_status', i.ld_presence_status,
      'is_new_document', i.is_new_document,
      'allocation', i.allocation,
      'ld_name', i.ld_name,
      'discipline', i.discipline,
      'revision', i.revision,
      'last_grdt', i.last_grdt,
      'requires_pdf_excel_pair', i.requires_pdf_excel_pair,
      'pdf_attachment_ready', i.pdf_attachment_ready,
      'excel_attachment_ready', i.excel_attachment_ready
    ) order by i.item_number), '[]'::jsonb)
    into itens
    from public.flow_request_items i where i.request_id = r.id;

  return jsonb_build_object(
    'protocol', r.protocol,
    'type_label', r.type_label,
    'status', r.status,
    'created_at', r.created_at,
    'due_at', r.due_at,
    'items_total', r.items_total,
    'items_done', r.items_done,
    'answer', r.answer,
    'requester_name', r.requester_name,
    'items', itens
  );
end;
$$;

grant execute on function public.flow_track_protocol(text) to authenticated;
