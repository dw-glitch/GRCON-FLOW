-- Mantem o historico de ajustes de protocolo privado e indexa a auditoria por usuario.

drop policy if exists "Ajustes de protocolo privados" on public.flow_protocol_adjustments;

create policy "Ajustes de protocolo privados"
on public.flow_protocol_adjustments
for all
to public
using (false)
with check (false);

create index if not exists flow_protocol_adjustments_changed_by_idx
  on public.flow_protocol_adjustments (changed_by);
