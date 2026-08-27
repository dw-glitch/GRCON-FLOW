-- GRCON Flow — exclusão completa de norma pelo proprietário.
--
-- A interface usa duas etapas: primeiro consulta o impacto e remove os objetos
-- pelo Storage API; depois esta função confirma que nenhum PDF ficou órfão e
-- apaga a norma. As revisões são removidas pela FK ON DELETE CASCADE e os
-- catálogos históricos apenas perdem a referência (ON DELETE SET NULL).

begin;

create or replace function public.flow_prepare_norm_deletion(target_norm uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  alvo public.flow_norms%rowtype;
  resultado jsonb;
begin
  if auth.uid() is null or not public.flow_is_owner() then
    raise exception 'Somente o proprietário pode excluir uma norma.' using errcode = '42501';
  end if;

  select * into alvo from public.flow_norms where id = target_norm;
  if not found then
    raise exception 'Norma não encontrada.' using errcode = 'P0002';
  end if;

  select jsonb_build_object(
    'id', alvo.id,
    'code', alvo.code,
    'title', alvo.title,
    'version_count', count(v.id),
    'file_count', count(o.id),
    'file_bytes', coalesce(sum(coalesce((o.metadata ->> 'size')::bigint, 0)), 0),
    'storage_paths', coalesce(
      jsonb_agg(distinct v.storage_path) filter (where btrim(coalesce(v.storage_path, '')) <> ''),
      '[]'::jsonb
    )
  ) into resultado
  from public.flow_norm_versions v
  left join storage.objects o
    on o.bucket_id = 'flow-normas' and o.name = v.storage_path
  where v.norm_id = alvo.id;

  return resultado;
end;
$$;

create or replace function public.flow_delete_norm(target_norm uuid, p_confirm_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  alvo public.flow_norms%rowtype;
  revisoes integer;
begin
  if auth.uid() is null or not public.flow_is_owner() then
    raise exception 'Somente o proprietário pode excluir uma norma.' using errcode = '42501';
  end if;

  select * into alvo from public.flow_norms where id = target_norm for update;
  if not found then
    raise exception 'Norma não encontrada.' using errcode = 'P0002';
  end if;
  if upper(btrim(coalesce(p_confirm_code, ''))) <> upper(btrim(alvo.code)) then
    raise exception 'Digite o código exato da norma para confirmar a exclusão.' using errcode = '23514';
  end if;

  -- Nunca apaga só o cadastro enquanto um objeto controlado continua ocupando
  -- o bucket. A interface pode repetir a remoção do Storage com segurança.
  if exists (
    select 1
      from public.flow_norm_versions v
      join storage.objects o
        on o.bucket_id = 'flow-normas' and o.name = v.storage_path
     where v.norm_id = alvo.id
  ) then
    raise exception 'Ainda existem PDFs desta norma no armazenamento. Repita a exclusão para concluir com segurança.'
      using errcode = '23514';
  end if;

  select count(*) into revisoes
    from public.flow_norm_versions v where v.norm_id = alvo.id;

  delete from public.flow_norms where id = alvo.id;
  return jsonb_build_object(
    'id', alvo.id,
    'code', alvo.code,
    'deleted_versions', revisoes,
    'deleted_at', clock_timestamp()
  );
end;
$$;

revoke all on function public.flow_prepare_norm_deletion(uuid) from public, anon, authenticated;
revoke all on function public.flow_delete_norm(uuid,text) from public, anon, authenticated;
grant execute on function public.flow_prepare_norm_deletion(uuid) to authenticated;
grant execute on function public.flow_delete_norm(uuid,text) to authenticated;

comment on function public.flow_delete_norm(uuid,text) is
  'Exclui permanentemente uma norma e suas revisões, somente após remover os PDFs e confirmar o código.';

commit;
