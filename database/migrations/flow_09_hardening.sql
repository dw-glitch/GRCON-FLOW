-- Exportada de supabase_migrations.schema_migrations em 03/09/2026.
-- Versão aplicada: 20260819210101.
--
-- Este arquivo é o SQL que de fato criou os objetos no projeto — não uma
-- reconstrução a partir do schema. Ele estava aplicado no banco mas nunca
-- havia sido versionado, o que impedia montar uma instalação nova (ou um
-- ambiente de homologação) a partir do repositório.
--
-- Não edite para corrigir comportamento: uma migração já aplicada é
-- histórico. Mudança de regra entra numa migração nova.

-- GRCON Flow — endurecimento da superfície exposta pela API.

-- 1. O contador do protocolo não é lido nem escrito por ninguém diretamente:
--    só a função flow_next_protocol() (SECURITY DEFINER) o toca. Sem policy
--    nenhuma, a tabela fica inacessível pela API mesmo com RLS ligada.
alter table public.flow_protocol_counters enable row level security;

-- 2. Extensões fora do schema público.
create schema if not exists extensions;
drop extension if exists unaccent;              -- não é mais usada
alter extension pg_trgm set schema extensions;

-- similarity() e o operador % passam a morar em extensions; a busca por título
-- precisa enxergar os dois schemas.
create or replace function public.flow_search_by_title(p_query text, p_limit integer default 12)
returns jsonb language sql stable security definer
set search_path = public, extensions as $$
  select coalesce(jsonb_agg(to_jsonb(c) order by c.score desc), '[]'::jsonb)
  from (
    select distinct on (d.document_key)
      d.document, d.document_key, d.title, d.revision, d.allocation,
      d.allocation_status, d.grdt, d.sigem_status, d.discipline, d.sheet,
      l.code as ld_code,
      similarity(d.title_norm, public.flow_norm_text(p_query)) as score
    from public.flow_ld_documents d
    join public.flow_ld_versions v on v.id = d.ld_version_id and v.status = 'ativa'
    join public.flow_lds l on l.id = d.ld_id and l.active
    where d.title_norm % public.flow_norm_text(p_query)
    order by d.document_key, score desc
    limit greatest(coalesce(p_limit, 12), 1)
  ) c
$$;

-- 3. Nada do GRCON Flow é acessível sem sessão. As funções abaixo passam a
--    exigir usuário autenticado; quem não entrou não alcança nem a lista de
--    documentos nem a criação de solicitação.
do $$
declare
  f text;
  somente_autenticado text[] := array[
    'public.flow_current_role()',
    'public.flow_current_name()',
    'public.flow_is_staff()',
    'public.flow_is_admin()',
    'public.flow_is_owner()',
    'public.flow_can_see_request(uuid)',
    'public.flow_create_request(text,text,text,text,text,text,jsonb,jsonb)',
    'public.flow_triage_item(uuid)',
    'public.flow_triage_request(uuid)',
    'public.flow_lookup_document(text[])',
    'public.flow_search_by_title(text,integer)',
    'public.flow_update_items(uuid[],text,text,text)',
    'public.flow_update_request(uuid,text,text,text)',
    'public.flow_track_protocol(text)',
    'public.flow_activate_ld_version(uuid)',
    'public.flow_delete_ld_version(uuid)',
    'public.flow_ingest_ld_documents(uuid,jsonb)',
    'public.flow_set_user_role(uuid,text)',
    'public.flow_norm_text(text)'
  ];
  interno text[] := array[
    'public.flow_handle_new_user()',
    'public.flow_items_progress_trigger()',
    'public.flow_next_protocol()',
    'public.flow_refresh_request_progress(uuid)'
  ];
begin
  foreach f in array somente_autenticado loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;

  -- Uso interno: chamadas por gatilho ou por outra função SECURITY DEFINER.
  -- Ninguém as invoca pela API.
  foreach f in array interno loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end;
$$;

-- 4. A view de exportação respeita as policies de quem consulta
--    (security_invoker), então o solicitante enxerga nela apenas o que é dele.
revoke all on public.flow_export_view from anon;
grant select on public.flow_export_view to authenticated;
