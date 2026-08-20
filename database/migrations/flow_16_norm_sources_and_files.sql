-- GRCON Flow — integridade das fontes normativas e anexos versionados.

-- Corrige os metadados conforme as capas dos PDFs controlados recebidos.
update public.flow_norms
set title = 'Formulários para Emissão de Documentos Técnicos de Engenharia',
    updated_at = now()
where code = 'N-0381';

update public.flow_norm_versions v
set effective_date = '2022-06-01'::date,
    notes = 'Revisão M com 1ª Errata de 06/2022 fornecida para a estrutura inicial.'
from public.flow_norms n
where n.id = v.norm_id and n.code = 'N-0381' and v.revision = 'M';

update public.flow_norms
set code = 'ABNT NBR ISO 9001',
    title = 'Sistemas de gestão da qualidade — Requisitos',
    updated_at = now()
where code = 'ISO 9001'
  and not exists (select 1 from public.flow_norms where code = 'ABNT NBR ISO 9001');

update public.flow_norms
set title = 'Medição de resistência de aterramento e de potenciais na superfície do solo em sistemas de aterramento',
    updated_at = now()
where code = 'NBR 15749';

-- A N-1710 possui texto principal e anexos com ciclos de revisão independentes.
with dados(code,title,revision,effective_date,annex) as (values
  ('N-1710-ANEXO-A','N-1710 — Anexo A — Categoria dos Documentos','W','2023-10-01'::date,'A'),
  ('N-1710-ANEXO-B','N-1710 — Anexo B — Identificação das Instalações','CJ','2025-04-01'::date,'B'),
  ('N-1710-ANEXO-C','N-1710 — Anexo C — Área de Atividade','BF','2024-12-01'::date,'C'),
  ('N-1710-ANEXO-D','N-1710 — Anexo D — Classes de Serviço','BG','2025-04-01'::date,'D'),
  ('N-1710-ANEXO-E','N-1710 — Anexo E — Área de Atividade Naval','D','2010-03-01'::date,'E'),
  ('N-1710-ANEXO-F','N-1710 — Anexo F — Classes de Serviço Naval','G','2014-10-01'::date,'F'),
  ('N-1710-ANEXO-G','N-1710 — Anexo G — Índice de Revisões','CN','2025-04-01'::date,'G')
), normas as (
  insert into public.flow_norms(code,title,scope)
  select code,title,'codificacao' from dados
  on conflict(code) do update set title=excluded.title,scope=excluded.scope,updated_at=now()
  returning id,code
)
insert into public.flow_norm_versions(norm_id,revision,effective_date,status,notes,rules)
select n.id,d.revision,d.effective_date,'ativa',
       'Referência recebida; o proprietário deve anexar a cópia controlada no painel.',
       jsonb_build_object('schema_version',1,'kind','n1710_annex','annex',d.annex)
from dados d join normas n on n.code=d.code
on conflict(norm_id,revision) do update
set effective_date=excluded.effective_date,
    notes=excluded.notes,
    rules=excluded.rules;

update public.flow_norm_versions v
set notes = 'Texto principal Rev. N (04/2020). Os anexos A a G são controlados separadamente.'
from public.flow_norms n
where n.id = v.norm_id and n.code = 'N-1710' and v.revision = 'N';

-- A revisão previamente cadastrada pode receber seu PDF sem criar uma duplicata.
create or replace function public.flow_create_norm_version(
  p_norm_code text, p_norm_title text, p_revision text, p_effective_date date,
  p_file_name text, p_notes text default '', p_rules jsonb default '{}'::jsonb
)
returns public.flow_norm_versions
language plpgsql
security definer
set search_path = public
as $$
declare norma uuid; nova public.flow_norm_versions;
begin
  if not public.flow_is_admin() then raise exception 'Somente administradores podem registrar normas.'; end if;
  if btrim(coalesce(p_norm_code,''))='' or btrim(coalesce(p_revision,''))='' then raise exception 'Informe norma e revisão.'; end if;
  if btrim(coalesce(p_file_name,''))='' then raise exception 'Anexe o PDF controlado da revisão.'; end if;

  insert into public.flow_norms (code,title)
  values (upper(btrim(p_norm_code)), btrim(coalesce(p_norm_title,'')))
  on conflict (code) do update set title=excluded.title,updated_at=now()
  returning id into norma;

  insert into public.flow_norm_versions (
    norm_id,revision,effective_date,status,file_name,notes,rules,created_by,created_by_name
  ) values (
    norma,upper(btrim(p_revision)),p_effective_date,'rascunho',btrim(p_file_name),coalesce(p_notes,''),
    coalesce(p_rules,'{}'::jsonb),auth.uid(),public.flow_current_name()
  )
  on conflict (norm_id,revision) do update
  set effective_date=coalesce(excluded.effective_date,flow_norm_versions.effective_date),
      file_name=excluded.file_name,
      notes=case when btrim(excluded.notes)<>'' then excluded.notes else flow_norm_versions.notes end,
      rules=case when excluded.rules<>'{}'::jsonb then excluded.rules else flow_norm_versions.rules end,
      status=case when flow_norm_versions.status='erro' then 'rascunho' else flow_norm_versions.status end,
      error_message='',
      created_by=auth.uid(),
      created_by_name=public.flow_current_name()
  where btrim(coalesce(flow_norm_versions.storage_path,''))=''
  returning * into nova;

  if nova.id is null then
    raise exception 'Esta revisão já possui um PDF controlado.';
  end if;
  return nova;
end;
$$;

create or replace function public.flow_set_norm_storage_path(target_version uuid, p_storage_path text)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.flow_is_admin() then raise exception 'Somente administradores podem vincular arquivos de normas.'; end if;
  if btrim(coalesce(p_storage_path,''))='' then raise exception 'Caminho do arquivo inválido.'; end if;
  update public.flow_norm_versions
  set storage_path=btrim(p_storage_path),error_message=''
  where id=target_version
    and status in ('rascunho','ativa','substituida')
    and btrim(coalesce(storage_path,''))='';
  if not found then raise exception 'Revisão normativa não encontrada ou já possui PDF.'; end if;
end; $$;

create or replace function public.flow_fail_norm_version(target_version uuid, p_message text)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.flow_is_admin() then raise exception 'Somente administradores podem registrar falhas de normas.'; end if;
  update public.flow_norm_versions
  set status=case when status='rascunho' then 'erro' else status end,
      file_name=case when status in ('ativa','substituida') then '' else file_name end,
      error_message=left(coalesce(p_message,''),500)
  where id=target_version and btrim(coalesce(storage_path,''))='';
end; $$;

-- Amplia os catálogos administráveis para os demais anexos da N-1710.
create or replace function public.flow_save_catalog_entry(
  p_catalog_code text, p_entry_code text, p_label text default '', p_active boolean default true
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare catalogo text:=upper(btrim(coalesce(p_catalog_code,'')));
        codigo text:=upper(btrim(coalesce(p_entry_code,''))); proxima integer;
begin
  if not public.flow_is_admin() then raise exception 'Somente administradores podem alterar códigos da qualidade.'; end if;
  if catalogo not in (
    'TIPOS_RELATORIO','CATEGORIAS_N1710','DISCIPLINAS_RELATORIO','EMISSORES_RELATORIO','UNIDADES_RELATORIO',
    'INSTALACOES_N1710','AREAS_ATIVIDADE_N1710','CLASSES_SERVICO_N1710',
    'AREAS_ATIVIDADE_NAVAL_N1710','CLASSES_SERVICO_NAVAL_N1710'
  ) then raise exception 'Catálogo desconhecido.'; end if;
  if codigo='' then raise exception 'Informe o código.'; end if;
  select coalesce(max(revision_no),0)+1 into proxima
  from public.flow_norm_catalog_entries where catalog_code=catalogo and entry_code=codigo;
  update public.flow_norm_catalog_entries set superseded_at=now()
   where catalog_code=catalogo and entry_code=codigo and superseded_at is null;
  insert into public.flow_norm_catalog_entries (catalog_code,entry_code,label,active,revision_no,changed_by)
  values (catalogo,codigo,coalesce(p_label,''),coalesce(p_active,true),proxima,auth.uid());
  return jsonb_build_object('catalog_code',catalogo,'entry_code',codigo,'active',coalesce(p_active,true),'revision_no',proxima);
end; $$;

create or replace function public.flow_active_code_rules()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare resultado jsonb;
begin
  if not public.flow_is_admin() then raise exception 'Somente administradores podem carregar regras de importação.'; end if;
  select jsonb_build_object(
    'schema_version', 2,
    'tipos_relatorio', coalesce((select jsonb_agg(entry_code order by entry_code) from public.flow_norm_catalog_entries where catalog_code='TIPOS_RELATORIO' and active and superseded_at is null), '[]'::jsonb),
    'categorias_n1710', coalesce((select jsonb_agg(entry_code order by entry_code) from public.flow_norm_catalog_entries where catalog_code='CATEGORIAS_N1710' and active and superseded_at is null), '[]'::jsonb),
    'disciplinas_relatorio', coalesce((select jsonb_agg(entry_code order by entry_code) from public.flow_norm_catalog_entries where catalog_code='DISCIPLINAS_RELATORIO' and active and superseded_at is null), '[]'::jsonb),
    'emissores', coalesce((select jsonb_agg(entry_code order by entry_code) from public.flow_norm_catalog_entries where catalog_code='EMISSORES_RELATORIO' and active and superseded_at is null), '[]'::jsonb),
    'unidades', coalesce((select jsonb_agg(entry_code order by entry_code) from public.flow_norm_catalog_entries where catalog_code='UNIDADES_RELATORIO' and active and superseded_at is null), '[]'::jsonb),
    'instalacoes_n1710', coalesce((select jsonb_agg(entry_code order by entry_code) from public.flow_norm_catalog_entries where catalog_code='INSTALACOES_N1710' and active and superseded_at is null), '[]'::jsonb),
    'areas_atividade_n1710', coalesce((select jsonb_agg(entry_code order by entry_code) from public.flow_norm_catalog_entries where catalog_code='AREAS_ATIVIDADE_N1710' and active and superseded_at is null), '[]'::jsonb),
    'classes_servico_n1710', coalesce((select jsonb_agg(entry_code order by entry_code) from public.flow_norm_catalog_entries where catalog_code='CLASSES_SERVICO_N1710' and active and superseded_at is null), '[]'::jsonb),
    'areas_atividade_naval_n1710', coalesce((select jsonb_agg(entry_code order by entry_code) from public.flow_norm_catalog_entries where catalog_code='AREAS_ATIVIDADE_NAVAL_N1710' and active and superseded_at is null), '[]'::jsonb),
    'classes_servico_naval_n1710', coalesce((select jsonb_agg(entry_code order by entry_code) from public.flow_norm_catalog_entries where catalog_code='CLASSES_SERVICO_NAVAL_N1710' and active and superseded_at is null), '[]'::jsonb),
    'norm_versions', coalesce((select jsonb_agg(jsonb_build_object('code',n.code,'revision',v.revision,'effective_date',v.effective_date) order by n.code)
      from public.flow_norm_versions v join public.flow_norms n on n.id=v.norm_id where v.status='ativa' and n.active), '[]'::jsonb)
  ) into resultado;
  return resultado;
end; $$;

-- Descrições oficiais do Anexo A Rev. W. CT e SIT continuam históricos,
-- mas deixam de ser classificados como categorias da N-1710.
update public.flow_norm_catalog_entries
set superseded_at=now()
where catalog_code='CATEGORIAS_N1710' and superseded_at is null;

with dados(entry_code,label,active) as (values
  ('CE','Certificado',true),('CR','Cronograma',true),('DB','Data-Book',true),('DE','Desenho',true),
  ('EC','Estimativa de Custos',true),('ET','Especificação Técnica',true),('FD','Folha de Dados',true),
  ('IM','Imagem',true),('IS','Isométrico',true),('LA','Laudo',true),('LD','Lista de Documentos',true),
  ('LI','Lista',true),('LO','Lógica',true),('MA','Manual',true),('MC','Memória de Cálculo',true),
  ('MD','Memorial Descritivo',true),('MO','Modelo',true),('PR','Procedimento',true),
  ('PT','Parecer Técnico',true),('RL','Relatório',true),('RM','Requisição de Material',true),
  ('CT','Consulta Técnica — código da ET, não pertence ao Anexo A',false),
  ('SIT','Solicitação de Informação Técnica — código da ET, não pertence ao Anexo A',false)
), fonte as (
  select v.id
  from public.flow_norm_versions v join public.flow_norms n on n.id=v.norm_id
  where n.code='N-1710-ANEXO-A' and v.revision='W'
)
insert into public.flow_norm_catalog_entries(
  catalog_code,entry_code,label,active,revision_no,source_norm_version_id
)
select 'CATEGORIAS_N1710',d.entry_code,d.label,d.active,
       coalesce((select max(e.revision_no)+1 from public.flow_norm_catalog_entries e
                 where e.catalog_code='CATEGORIAS_N1710' and e.entry_code=d.entry_code),1),
       f.id
from dados d cross join fonte f;

revoke all on function public.flow_create_norm_version(text,text,text,date,text,text,jsonb) from public,anon;
revoke all on function public.flow_set_norm_storage_path(uuid,text) from public,anon;
revoke all on function public.flow_fail_norm_version(uuid,text) from public,anon;
revoke all on function public.flow_save_catalog_entry(text,text,text,boolean) from public,anon;
revoke all on function public.flow_active_code_rules() from public,anon;
grant execute on function public.flow_create_norm_version(text,text,text,date,text,text,jsonb),
  public.flow_set_norm_storage_path(uuid,text), public.flow_fail_norm_version(uuid,text),
  public.flow_save_catalog_entry(text,text,text,boolean), public.flow_active_code_rules()
to authenticated,service_role;
