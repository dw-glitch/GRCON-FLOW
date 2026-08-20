-- Correção de dados para projetos que aplicaram flow_13 antes de a CTE de
-- normas usar o RETURNING da própria inserção.
with dados(code,revision,effective_date,status,notes) as (values
  ('ET-5290.00-22000-912-1LV-001','N',null::date,'substituida','Revisão histórica'),
  ('ET-5290.00-22000-912-1LV-001','P',null::date,'substituida','Revisão histórica'),
  ('ET-5290.00-22000-912-1LV-001','Q','2026-08-12'::date,'ativa','Revisão aprovada fornecida para a estrutura inicial'),
  ('N-1710','N','2020-04-01'::date,'ativa','Anexos A a G cadastrados como referências da mesma norma'),
  ('N-0381','M',null::date,'ativa','Inclui errata fornecida'),
  ('NBR 5419-1','2026','2026-04-02'::date,'ativa','Referência técnica'),
  ('NBR 5419-2','2026','2026-04-02'::date,'ativa','Referência técnica'),
  ('NBR 5419-3','2026','2026-04-02'::date,'ativa','Referência técnica'),
  ('NBR 5419-4','2026','2026-04-02'::date,'ativa','Referência técnica'),
  ('NBR 15749','2009',null::date,'ativa','Referência técnica'),
  ('ISO 9001','2015',null::date,'ativa','Arquivo recebido é tradução para treinamento; validar a cópia controlada antes de uso normativo')
)
insert into public.flow_norm_versions(norm_id,revision,effective_date,status,notes,rules)
select n.id,d.revision,d.effective_date,d.status,d.notes,
       case when d.code='ET-5290.00-22000-912-1LV-001' and d.revision='Q'
         then '{"schema_version":1,"kind":"document_coding","issuer":"C1O","unit":"U32"}'::jsonb
         else '{}'::jsonb end
from dados d join public.flow_norms n on n.code=d.code
on conflict(norm_id,revision) do nothing;
