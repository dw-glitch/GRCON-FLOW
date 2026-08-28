-- GRCON Flow — registro rápido em nome do solicitante, exclusivo da Qualidade.
--
-- A interface esconde o botão de solicitantes, mas a autorização real está
-- aqui. O papel vem de flow_profiles por flow_is_staff(); não depende de
-- user_metadata nem de informação enviada pelo navegador.
--
-- A função é SECURITY INVOKER: ela valida a equipe e delega a criação à mesma
-- rotina idempotente usada pelo formulário completo. Assim, protocolo,
-- autoria, prazos, histórico e criação set-based dos itens permanecem iguais.

create or replace function public.flow_create_staff_request(
  p_type_code text,
  p_requester_name text,
  p_requester_area text,
  p_requester_contact text,
  p_summary text,
  p_description text,
  p_form_data jsonb,
  p_items jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'É preciso estar autenticado para usar o registro rápido.'
      using errcode = '42501';
  end if;

  if not public.flow_is_staff() then
    raise exception 'Somente a equipe da Qualidade pode usar o registro rápido.'
      using errcode = '42501';
  end if;

  if nullif(btrim(coalesce(p_requester_name, '')), '') is null then
    raise exception 'Informe o nome do solicitante.' using errcode = '23514';
  end if;

  if nullif(btrim(coalesce(p_summary, '')), '') is null then
    raise exception 'Resuma o que foi solicitado.' using errcode = '23514';
  end if;

  return public.flow_create_request(
    p_type_code,
    p_requester_name,
    p_requester_area,
    p_requester_contact,
    p_summary,
    p_description,
    coalesce(p_form_data, '{}'::jsonb)
      || jsonb_build_object('origem_registro', 'Registro rápido pela Qualidade'),
    coalesce(p_items, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.flow_create_staff_request(text,text,text,text,text,text,jsonb,jsonb)
  from public, anon;
grant execute on function public.flow_create_staff_request(text,text,text,text,text,text,jsonb,jsonb)
  to authenticated;

comment on function public.flow_create_staff_request(text,text,text,text,text,text,jsonb,jsonb) is
  'Entrada idempotente do painel para operador, administrador e proprietário registrarem pedido em nome de terceiro.';
