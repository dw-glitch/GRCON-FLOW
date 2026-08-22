-- GRCON Flow — métricas reais de armazenamento e atualização reativa.
-- Storage e banco possuem cotas distintas no Supabase e não devem ser somados
-- em uma única porcentagem.

begin;

drop function if exists public.flow_storage_usage();

create function public.flow_storage_usage()
returns table(
  total_bytes bigint,
  total_files bigint,
  attachment_bytes bigint,
  attachment_files bigint,
  ld_bytes bigint,
  ld_files bigint,
  norm_bytes bigint,
  norm_files bigint,
  database_bytes bigint,
  measured_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.flow_is_staff() then
    raise exception 'Sem permissão para consultar o armazenamento.' using errcode = '42501';
  end if;

  return query
  select
    coalesce(sum(coalesce((o.metadata ->> 'size')::bigint, 0)), 0)::bigint as total_bytes,
    count(*)::bigint as total_files,
    coalesce(sum(coalesce((o.metadata ->> 'size')::bigint, 0))
      filter (where o.bucket_id = 'flow-anexos'), 0)::bigint as attachment_bytes,
    (count(*) filter (where o.bucket_id = 'flow-anexos'))::bigint as attachment_files,
    coalesce(sum(coalesce((o.metadata ->> 'size')::bigint, 0))
      filter (where o.bucket_id = 'flow-lds'), 0)::bigint as ld_bytes,
    (count(*) filter (where o.bucket_id = 'flow-lds'))::bigint as ld_files,
    coalesce(sum(coalesce((o.metadata ->> 'size')::bigint, 0))
      filter (where o.bucket_id = 'flow-normas'), 0)::bigint as norm_bytes,
    (count(*) filter (where o.bucket_id = 'flow-normas'))::bigint as norm_files,
    pg_database_size(current_database())::bigint as database_bytes,
    clock_timestamp() as measured_at
  from storage.objects o;
end;
$$;

revoke all on function public.flow_storage_usage() from public, anon, authenticated;
grant execute on function public.flow_storage_usage() to authenticated;

comment on function public.flow_storage_usage() is
  'Uso real de Storage por bucket e tamanho atual do Postgres. Somente equipe autenticada.';

-- Os eventos abaixo permitem que o painel atualize o indicador imediatamente
-- quando anexos, versões de LD ou normas mudarem. O polling do frontend segue
-- como fallback para alterações que não gerem um desses eventos.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'flow_attachments'
  ) then
    alter publication supabase_realtime add table public.flow_attachments;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'flow_ld_versions'
  ) then
    alter publication supabase_realtime add table public.flow_ld_versions;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'flow_norm_versions'
  ) then
    alter publication supabase_realtime add table public.flow_norm_versions;
  end if;
end;
$$;

commit;
