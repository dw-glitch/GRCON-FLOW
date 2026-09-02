-- GRCON Flow 51 — o ano do protocolo passa a ser o ano de Brasília, o teto de
-- 999999 vale também no gerador, e a auditoria da numeração ganha leitura.
--
-- 1) `extract(year from now())` usava o `TimeZone` do banco, que é UTC: entre
--    21h e meia-noite de 31/12 o protocolo já saía com o ano seguinte, e até
--    3h de 01/01 saía com o ano anterior. São duas janelas de três horas por
--    ano em que o número não corresponde ao ano em que o pedido chegou.
-- 2) o gerador não conferia o limite de seis dígitos que a tela e o ajuste
--    administrativo já impunham: acima dele nasceria `FLOW-AAAA-1000000`.
-- 3) `flow_protocol_adjustments` era gravada e não podia ser lida por ninguém
--    pela aplicação — a auditoria existia sem caminho de consulta.
--
-- Nada renumera protocolo existente. O contador de cada ano segue como está.

begin;

-- O fuso da operação, num lugar só. Se um dia a empresa mudar de fuso, muda
-- aqui — e não em três funções que precisariam concordar entre si.
create or replace function public.flow_protocol_year()
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select extract(year from (now() at time zone 'America/Sao_Paulo'))::integer;
$$;

revoke all on function public.flow_protocol_year() from public, anon;
grant execute on function public.flow_protocol_year() to authenticated, service_role;

create or replace function public.flow_next_protocol()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  ano integer := public.flow_protocol_year();
  proximo integer;
begin
  insert into public.flow_protocol_counters (year, last_number)
  values (ano, 1)
  on conflict (year) do update
    set last_number = public.flow_protocol_counters.last_number + 1
  returning last_number into proximo;

  if proximo > 999999 then
    raise exception
      'A numeração de % chegou ao limite de 999999 protocolos.', ano
      using errcode = '22003';
  end if;

  return 'FLOW-' || ano::text || '-' || lpad(proximo::text, 6, '0');
end;
$$;

revoke all on function public.flow_next_protocol() from public, anon, authenticated;
grant execute on function public.flow_next_protocol() to service_role;

create or replace function public.flow_protocol_settings()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ano integer := public.flow_protocol_year();
  ultimo integer := 0;
  maior_usado integer := 0;
  historico jsonb;
begin
  if not public.flow_is_admin() then
    raise exception 'Somente administradores podem consultar a numeração.';
  end if;

  select coalesce(last_number, 0) into ultimo
    from public.flow_protocol_counters where year = ano;
  select coalesce(max(substring(protocol from 11)::integer), 0) into maior_usado
    from public.flow_requests
   where protocol ~ ('^FLOW-' || ano::text || '-[0-9]{1,9}$');

  -- Quem escolheu, quando, e de que número para qual. A tabela continua fechada
  -- por RLS; esta função é o único caminho de leitura, e só para administrador.
  select coalesce(jsonb_agg(linha order by linha->>'created_at' desc), '[]'::jsonb)
    into historico
    from (
      select jsonb_build_object(
        'year', a.year,
        'previous_last_number', a.previous_last_number,
        'next_number', a.next_number,
        'changed_by_name', a.changed_by_name,
        'created_at', a.created_at
      ) as linha
      from public.flow_protocol_adjustments a
      order by a.created_at desc
      limit 50
    ) recentes;

  return jsonb_build_object(
    'year', ano,
    'last_number', ultimo,
    'last_protocol', case when ultimo > 0 then 'FLOW-' || ano::text || '-' || lpad(ultimo::text, 6, '0') else '' end,
    'next_number', greatest(ultimo, maior_usado) + 1,
    'minimum_next_number', greatest(ultimo, maior_usado) + 1,
    'maximum_next_number', 999999,
    'adjustments', historico
  );
end;
$$;

revoke all on function public.flow_protocol_settings() from public, anon;
grant execute on function public.flow_protocol_settings() to authenticated;

create or replace function public.flow_set_next_protocol(p_next_number integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ano integer := public.flow_protocol_year();
  ultimo integer := 0;
  maior_usado integer := 0;
  minimo integer;
begin
  if not public.flow_is_admin() then
    raise exception 'Somente administradores podem alterar a numeração.';
  end if;
  if p_next_number is null or p_next_number < 1 or p_next_number > 999999 then
    raise exception 'Informe um número inteiro entre 1 e 999999.';
  end if;

  insert into public.flow_protocol_counters(year, last_number)
  values (ano, 0)
  on conflict (year) do nothing;

  select last_number into ultimo
    from public.flow_protocol_counters where year = ano for update;
  select coalesce(max(substring(protocol from 11)::integer), 0) into maior_usado
    from public.flow_requests
   where protocol ~ ('^FLOW-' || ano::text || '-[0-9]{1,9}$');
  minimo := greatest(ultimo, maior_usado) + 1;

  if minimo > 999999 then
    raise exception 'A numeração de % já alcançou 999999; não há número livre neste ano.', ano;
  end if;
  if p_next_number < minimo then
    raise exception 'O próximo número deve ser no mínimo % para não repetir nem retroceder a sequência.', minimo;
  end if;

  insert into public.flow_protocol_adjustments(
    year, previous_last_number, next_number, changed_by, changed_by_name
  ) values (
    ano, ultimo, p_next_number, auth.uid(), public.flow_current_name()
  );

  update public.flow_protocol_counters
     set last_number = p_next_number - 1
   where year = ano;

  return jsonb_build_object(
    'year', ano,
    'previous_last_number', ultimo,
    'next_number', p_next_number,
    'next_protocol', 'FLOW-' || ano::text || '-' || lpad(p_next_number::text, 6, '0')
  );
end;
$$;

revoke all on function public.flow_set_next_protocol(integer) from public, anon;
grant execute on function public.flow_set_next_protocol(integer) to authenticated;

commit;
