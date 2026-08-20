-- GRCON Flow — importação segura e auditável das LDs.
-- A migração é idempotente quanto a colunas/índices e preserva versões antigas.

alter table public.flow_ld_versions
  add column if not exists source_hash text not null default '',
  add column if not exists import_report jsonb not null default '{}'::jsonb,
  add column if not exists finalized_at timestamptz;

alter table public.flow_ld_versions drop constraint if exists flow_ld_versions_status_check;
alter table public.flow_ld_versions add constraint flow_ld_versions_status_check
  check (status in ('processando','pronta','ativa','inativa','erro'));

create unique index if not exists flow_ld_documents_version_key_uidx
  on public.flow_ld_documents (ld_version_id, document_key)
  where document_key <> '';

create unique index if not exists flow_ld_versions_source_hash_uidx
  on public.flow_ld_versions (ld_id, source_hash)
  where source_hash <> '' and status <> 'erro';

create or replace function public.flow_save_ld(
  p_id uuid,
  p_code text,
  p_name text default '',
  p_description text default '',
  p_active boolean default true,
  p_display_order integer default 0
)
returns public.flow_lds
language plpgsql
security definer
set search_path = public
as $$
declare salvo public.flow_lds;
begin
  if not public.flow_is_admin() then
    raise exception 'Somente administradores podem alterar a Base Documental.';
  end if;
  if btrim(coalesce(p_code, '')) = '' then raise exception 'Informe o identificador da LD.'; end if;

  if p_id is null then
    insert into public.flow_lds (code, name, description, active, display_order)
    values (upper(btrim(p_code)), coalesce(p_name,''), coalesce(p_description,''), coalesce(p_active,true), coalesce(p_display_order,0))
    returning * into salvo;
  else
    update public.flow_lds
       set code = upper(btrim(p_code)), name = coalesce(p_name,''), description = coalesce(p_description,''),
           active = coalesce(p_active,true), display_order = coalesce(p_display_order,0), updated_at = now()
     where id = p_id returning * into salvo;
    if not found then raise exception 'LD não encontrada.'; end if;
  end if;
  return salvo;
end;
$$;

create or replace function public.flow_create_ld_version(
  p_ld_id uuid,
  p_revision_label text,
  p_file_name text,
  p_uploaded_by_name text,
  p_source_hash text,
  p_sheets jsonb,
  p_import_report jsonb
)
returns public.flow_ld_versions
language plpgsql
security definer
set search_path = public
as $$
declare nova public.flow_ld_versions;
begin
  if not public.flow_is_admin() then
    raise exception 'Somente administradores podem criar versões de LD.';
  end if;
  if not exists (select 1 from public.flow_lds where id = p_ld_id) then raise exception 'LD não encontrada.'; end if;
  if btrim(coalesce(p_file_name,'')) = '' then raise exception 'Arquivo da LD não informado.'; end if;
  if coalesce(p_import_report->>'schema_version','') <> '1' then raise exception 'Relatório de importação ausente ou incompatível.'; end if;
  if coalesce((p_import_report->>'history_rows_excluded')::integer, 0) < 0 then raise exception 'Relatório de importação inválido.'; end if;

  insert into public.flow_ld_versions (
    ld_id, revision_label, file_name, status, uploaded_by, uploaded_by_name,
    source_hash, sheets, import_report
  ) values (
    p_ld_id, coalesce(p_revision_label,''), btrim(p_file_name), 'processando', auth.uid(),
    coalesce(p_uploaded_by_name,''), lower(btrim(coalesce(p_source_hash,''))),
    coalesce(p_sheets,'[]'::jsonb), coalesce(p_import_report,'{}'::jsonb)
  ) returning * into nova;
  return nova;
exception when unique_violation then
  raise exception 'Este mesmo arquivo já foi importado para esta LD.';
end;
$$;

create or replace function public.flow_set_ld_storage_path(target_version uuid, p_storage_path text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.flow_is_admin() then raise exception 'Somente administradores podem vincular arquivos de LD.'; end if;
  update public.flow_ld_versions set storage_path = btrim(coalesce(p_storage_path,''))
   where id = target_version and status = 'processando';
  if not found then raise exception 'Versão de LD não encontrada ou fora de processamento.'; end if;
end;
$$;

create or replace function public.flow_ingest_ld_documents(target_version uuid, docs jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare alvo record; gravados integer := 0;
begin
  if not public.flow_is_admin() then raise exception 'Somente administradores podem atualizar a Base Documental.'; end if;
  select v.*, l.id as ld into alvo
    from public.flow_ld_versions v join public.flow_lds l on l.id = v.ld_id
   where v.id = target_version for update of v;
  if not found then raise exception 'Versão de LD não encontrada.'; end if;
  if alvo.status <> 'processando' then raise exception 'Esta versão não aceita novos lotes.'; end if;
  if jsonb_typeof(docs) <> 'array' then raise exception 'Lote inválido: esperado um array de documentos.'; end if;

  insert into public.flow_ld_documents (
    ld_version_id, ld_id, document, document_key, nt_key, title, title_norm,
    revision, allocation, allocation_status, allocation_kind, grdt, sigem_status,
    discipline, document_type, purpose, tag, sheet, row_number, ld_version_label, raw
  )
  select distinct on (d->>'document_key')
    target_version, alvo.ld, coalesce(d->>'document',''), coalesce(d->>'document_key',''),
    coalesce(d->>'nt_key',''), coalesce(d->>'title',''), coalesce(d->>'title_norm',''),
    coalesce(d->>'revision',''), coalesce(d->>'allocation',''), coalesce(d->>'allocation_status',''),
    coalesce(d->>'allocation_kind',''), coalesce(d->>'grdt',''), coalesce(d->>'sigem_status',''),
    coalesce(d->>'discipline',''), coalesce(d->>'document_type',''), coalesce(d->>'purpose',''),
    coalesce(d->>'tag',''), coalesce(d->>'sheet',''), coalesce((d->>'row_number')::integer,0),
    coalesce(d->>'ld_version_label',''), coalesce(d->'raw','{}'::jsonb)
  from jsonb_array_elements(docs) d
  where coalesce(d->>'document_key','') <> ''
    and upper(btrim(coalesce(d->>'sheet',''))) <> 'COLAR SIGEM'
    and coalesce(d->'raw'->>'source_kind','technical') = 'technical'
  order by d->>'document_key', coalesce((d->>'row_number')::integer,0) desc
  on conflict (ld_version_id, document_key) where document_key <> '' do update set
    document = excluded.document, nt_key = excluded.nt_key, title = excluded.title,
    title_norm = excluded.title_norm, revision = excluded.revision,
    allocation = excluded.allocation, allocation_status = excluded.allocation_status,
    allocation_kind = excluded.allocation_kind, grdt = excluded.grdt,
    sigem_status = excluded.sigem_status, discipline = excluded.discipline,
    document_type = excluded.document_type, purpose = excluded.purpose, tag = excluded.tag,
    sheet = excluded.sheet, row_number = excluded.row_number,
    ld_version_label = excluded.ld_version_label, raw = excluded.raw;

  get diagnostics gravados = row_count;
  update public.flow_ld_versions v set document_count = (
    select count(*)::integer from public.flow_ld_documents d where d.ld_version_id = target_version
  ) where v.id = target_version;
  return gravados;
end;
$$;

create or replace function public.flow_finalize_ld_version(target_version uuid, p_report jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare alvo record; total integer;
begin
  if not public.flow_is_admin() then raise exception 'Somente administradores podem finalizar uma versão de LD.'; end if;
  select * into alvo from public.flow_ld_versions where id = target_version for update;
  if not found or alvo.status <> 'processando' then raise exception 'Versão de LD não encontrada ou fora de processamento.'; end if;
  if btrim(coalesce(alvo.storage_path,'')) = '' then raise exception 'O arquivo original não foi guardado.'; end if;
  if coalesce(p_report->>'schema_version','') <> '1' then raise exception 'Relatório de importação inválido.'; end if;
  if coalesce((p_report->>'conflicting_documents')::integer,0) > 0
     and coalesce(p_report->>'conflict_resolution','') <> 'linha_mais_recente' then
    raise exception 'Existem conflitos sem uma regra de resolução aprovada.';
  end if;
  select count(*)::integer into total from public.flow_ld_documents where ld_version_id = target_version;
  if total <= 0 then raise exception 'Nenhum documento técnico foi indexado.'; end if;
  if total <> coalesce((p_report->>'unique_documents')::integer,-1) then
    raise exception 'A contagem indexada (%) difere da pré-análise (%).', total, p_report->>'unique_documents';
  end if;
  update public.flow_ld_versions
     set document_count = total, import_report = p_report, status = 'pronta', finalized_at = now(), error_message = ''
   where id = target_version;
end;
$$;

create or replace function public.flow_activate_ld_version(target_version uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare alvo record; total integer;
begin
  if not public.flow_is_admin() then raise exception 'Somente administradores podem ativar uma versão de LD.'; end if;
  select * into alvo from public.flow_ld_versions where id = target_version for update;
  if not found then raise exception 'Versão de LD não encontrada.'; end if;
  if alvo.status not in ('pronta','inativa','ativa') then raise exception 'A versão precisa concluir a pré-análise antes de ser ativada.'; end if;
  if btrim(coalesce(alvo.storage_path,'')) = '' or coalesce(alvo.import_report->>'schema_version','') <> '1' then
    raise exception 'A versão não possui arquivo e relatório de importação auditáveis.';
  end if;
  select count(*)::integer into total from public.flow_ld_documents where ld_version_id = target_version;
  if total <= 0 or total <> alvo.document_count then raise exception 'A indexação desta versão está incompleta.'; end if;

  update public.flow_ld_versions set status = 'inativa'
   where ld_id = alvo.ld_id and id <> target_version and status = 'ativa';
  update public.flow_ld_versions set status = 'ativa', activated_at = now(), error_message = ''
   where id = target_version;
  update public.flow_lds set current_version_id = target_version, updated_at = now() where id = alvo.ld_id;
end;
$$;

create or replace function public.flow_fail_ld_version(target_version uuid, p_message text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.flow_is_admin() then raise exception 'Somente administradores podem registrar falhas de LD.'; end if;
  update public.flow_ld_versions set status = 'erro', error_message = left(coalesce(p_message,''),500)
   where id = target_version and status <> 'ativa';
end;
$$;

revoke all on function public.flow_save_ld(uuid,text,text,text,boolean,integer) from public, anon;
revoke all on function public.flow_create_ld_version(uuid,text,text,text,text,jsonb,jsonb) from public, anon;
revoke all on function public.flow_set_ld_storage_path(uuid,text) from public, anon;
revoke all on function public.flow_finalize_ld_version(uuid,jsonb) from public, anon;
revoke all on function public.flow_fail_ld_version(uuid,text) from public, anon;
grant execute on function public.flow_save_ld(uuid,text,text,text,boolean,integer) to authenticated, service_role;
grant execute on function public.flow_create_ld_version(uuid,text,text,text,text,jsonb,jsonb) to authenticated, service_role;
grant execute on function public.flow_set_ld_storage_path(uuid,text) to authenticated, service_role;
grant execute on function public.flow_finalize_ld_version(uuid,jsonb) to authenticated, service_role;
grant execute on function public.flow_fail_ld_version(uuid,text) to authenticated, service_role;

revoke insert, update, delete on public.flow_lds, public.flow_ld_versions, public.flow_ld_documents from authenticated;
grant select on public.flow_lds, public.flow_ld_versions, public.flow_ld_documents to authenticated;
