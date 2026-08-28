-- Índice de cobertura da FK dos favoritos para os tipos de solicitação.
-- Evita varredura completa se um tipo for atualizado ou validado pelo banco.

create index if not exists flow_quick_templates_type_code_idx
  on public.flow_quick_templates (type_code);
