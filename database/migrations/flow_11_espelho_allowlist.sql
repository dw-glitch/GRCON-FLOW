-- Exportada de supabase_migrations.schema_migrations em 03/09/2026.
-- Versão aplicada: 20260820101331.
--
-- Este arquivo é o SQL que de fato criou os objetos no projeto — não uma
-- reconstrução a partir do schema. Ele estava aplicado no banco mas nunca
-- havia sido versionado, o que impedia montar uma instalação nova (ou um
-- ambiente de homologação) a partir do repositório.
--
-- Não edite para corrigir comportamento: uma migração já aplicada é
-- histórico. Mudança de regra entra numa migração nova.

-- GRCON Flow — manter a lista de acesso coerente com os papéis.
--
-- Sem isto haveria duas verdades: promover alguém em Painel → Usuários não
-- apareceria na lista de acesso, e uma releitura futura da lista poderia
-- rebaixar a pessoa em silêncio.
--
-- A regra: o papel gravado no perfil manda. A lista é (a) o jeito de conceder
-- acesso a quem AINDA não se cadastrou e (b) um espelho de quem é da equipe.

create or replace function public.flow_set_user_role(target_user uuid, new_role text)
returns void language plpgsql security definer set search_path = public as $$
declare
  alvo text;
begin
  if not public.flow_is_admin() then
    raise exception 'Somente administradores podem alterar papéis.';
  end if;
  if new_role not in ('solicitante','operador','administrador','proprietario') then
    raise exception 'Papel inválido: %', new_role;
  end if;
  -- Só o proprietário cria outro proprietário.
  if new_role = 'proprietario' and not public.flow_is_owner() then
    raise exception 'Somente o proprietário pode promover outro proprietário.';
  end if;
  -- Nunca deixar a aplicação sem nenhum proprietário ativo.
  if new_role <> 'proprietario'
     and (select role from public.flow_profiles where id = target_user) = 'proprietario'
     and (select count(*) from public.flow_profiles where role = 'proprietario' and active) <= 1 then
    raise exception 'É preciso manter ao menos um proprietário ativo.';
  end if;

  update public.flow_profiles
     set role = new_role, updated_at = now()
   where id = target_user
   returning lower(btrim(email)) into alvo;

  if alvo is null or alvo = '' then return; end if;

  if new_role = 'solicitante' then
    delete from public.flow_access_allowlist where email = alvo;
  else
    insert into public.flow_access_allowlist (email, role, note, created_by)
    values (alvo, new_role, 'Espelho da promoção feita em Usuários.', auth.uid())
    on conflict (email) do update set role = excluded.role;
  end if;
end;
$$;

revoke all on function public.flow_set_user_role(uuid, text) from public, anon;
grant execute on function public.flow_set_user_role(uuid, text) to authenticated;
