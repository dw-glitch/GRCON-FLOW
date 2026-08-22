-- GRCON Flow — métricas de capacidade exclusivas do proprietário.
-- O valor de banco segue a consulta documentada pelo Supabase: soma todos os
-- databases do cluster, não apenas current_database().

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
  if auth.uid() is null or not public.flow_is_owner() then
    raise exception 'Somente o proprietário pode consultar o armazenamento.' using errcode = '42501';
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
    (select coalesce(sum(pg_database_size(d.datname)), 0)::bigint from pg_database d) as database_bytes,
    clock_timestamp() as measured_at
  from storage.objects o;
end;
$$;

revoke all on function public.flow_storage_usage() from public, anon, authenticated;
grant execute on function public.flow_storage_usage() to authenticated;

comment on function public.flow_storage_usage() is
  'Uso atual dos objetos do Storage e tamanho total dos databases do cluster. Exclusivo do proprietário.';

commit;
