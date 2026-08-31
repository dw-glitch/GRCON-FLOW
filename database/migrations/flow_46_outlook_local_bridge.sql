-- GRCON Flow — Fase 3: ponte local do Outlook clássico.
--
-- Cada computador recebe uma credencial própria. O segredo em si nunca entra
-- no banco: somente o SHA-256 criado pelo instalador local é registrado. A
-- administração pode ver atividade e revogar uma ponte sem afetar as demais.

begin;

alter table public.flow_external_webhook_secrets
  add column if not exists bridge_id uuid,
  add column if not exists kind text not null default 'legacy',
  add column if not exists label text not null default '',
  add column if not exists submitted_by_email text,
  add column if not exists created_by uuid references auth.users(id) on delete set null,
  add column if not exists last_used_at timestamptz,
  add column if not exists last_result text not null default '',
  add column if not exists last_error text not null default '',
  add column if not exists revoked_at timestamptz;

alter table public.flow_external_webhook_secrets
  drop constraint if exists flow_external_webhook_secrets_kind_check,
  add constraint flow_external_webhook_secrets_kind_check
    check (kind in ('legacy', 'outlook_local')),
  drop constraint if exists flow_external_webhook_secrets_label_check,
  add constraint flow_external_webhook_secrets_label_check
    check (char_length(label) <= 120),
  drop constraint if exists flow_external_webhook_secrets_submitter_check,
  add constraint flow_external_webhook_secrets_submitter_check
    check (
      submitted_by_email is null
      or (
        submitted_by_email = lower(btrim(submitted_by_email))
        and char_length(submitted_by_email) <= 254
        and submitted_by_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      )
    ),
  drop constraint if exists flow_external_webhook_secrets_last_result_check,
  add constraint flow_external_webhook_secrets_last_result_check
    check (char_length(last_result) <= 80),
  drop constraint if exists flow_external_webhook_secrets_last_error_check,
  add constraint flow_external_webhook_secrets_last_error_check
    check (char_length(last_error) <= 300);

create unique index if not exists flow_external_webhook_secrets_bridge_id_uidx
  on public.flow_external_webhook_secrets (bridge_id)
  where bridge_id is not null;

create index if not exists flow_external_inbox_redaction_idx
  on public.flow_external_inbox (reviewed_at)
  where body_redacted_at is null
    and status in ('convertido', 'descartado');

-- A limpeza é propositalmente limitada. Assim, um acúmulo antigo nunca
-- transforma a chegada de um novo lote em uma atualização longa ou timeout.
create or replace function public.flow_redact_external_inbox_batch(
  p_cutoff timestamptz,
  p_limit integer default 200
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  quantidade integer;
begin
  with alvos as (
    select i.id
      from public.flow_external_inbox i
     where i.body_redacted_at is null
       and i.status in ('convertido', 'descartado')
       and i.reviewed_at < p_cutoff
     order by i.reviewed_at
     limit least(greatest(coalesce(p_limit, 200), 1), 500)
     for update skip locked
  )
  update public.flow_external_inbox i
     set body_text = '',
         body_redacted_at = now(),
         updated_at = now()
    from alvos
   where i.id = alvos.id;

  get diagnostics quantidade = row_count;
  return quantidade;
end;
$$;

revoke all on function public.flow_redact_external_inbox_batch(timestamptz,integer)
  from public, anon, authenticated;
grant execute on function public.flow_redact_external_inbox_batch(timestamptz,integer)
  to service_role;

-- O código de pareamento contém somente UUID, e-mail, rótulo e hash. Ele não
-- contém o segredo e, portanto, pode ser colado no painel com segurança.
create or replace function public.flow_register_outlook_bridge(
  p_bridge_id uuid,
  p_secret_hash text,
  p_submitted_by_email text,
  p_label text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ator_role text := public.flow_current_role();
  email_alvo text := lower(btrim(coalesce(p_submitted_by_email, '')));
  hash_alvo text := lower(btrim(coalesce(p_secret_hash, '')));
  rotulo text := left(btrim(coalesce(p_label, '')), 120);
begin
  if auth.uid() is null or ator_role not in ('administrador', 'proprietario') then
    raise exception 'Somente administradores podem ativar a ponte do Outlook.'
      using errcode = '42501';
  end if;
  if p_bridge_id is null then
    raise exception 'Identificador da ponte inválido.' using errcode = '23514';
  end if;
  if hash_alvo !~ '^[0-9a-f]{64}$' then
    raise exception 'Código de pareamento inválido.' using errcode = '23514';
  end if;
  if email_alvo = '' or email_alvo !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'E-mail da Qualidade inválido.' using errcode = '23514';
  end if;
  if not exists (
    select 1
      from public.flow_profiles p
     where p.email = email_alvo
       and p.active
       and p.role in ('operador', 'administrador', 'proprietario')
  ) then
    raise exception 'O e-mail precisa pertencer a um perfil ativo da Qualidade.'
      using errcode = '23514';
  end if;

  insert into public.flow_external_webhook_secrets (
    name, bridge_id, kind, label, submitted_by_email, secret_hash, active,
    created_by, created_at, rotated_at, revoked_at, last_result, last_error
  ) values (
    'outlook_local:' || p_bridge_id::text,
    p_bridge_id,
    'outlook_local',
    coalesce(nullif(rotulo, ''), 'Outlook de ' || email_alvo),
    email_alvo,
    hash_alvo,
    true,
    auth.uid(),
    now(),
    now(),
    null,
    'aguardando_teste',
    ''
  )
  on conflict (name) do update
    set bridge_id = excluded.bridge_id,
        kind = excluded.kind,
        label = excluded.label,
        submitted_by_email = excluded.submitted_by_email,
        secret_hash = excluded.secret_hash,
        active = true,
        created_by = auth.uid(),
        rotated_at = now(),
        revoked_at = null,
        last_result = 'aguardando_teste',
        last_error = '';

  return jsonb_build_object(
    'bridge_id', p_bridge_id,
    'label', coalesce(nullif(rotulo, ''), 'Outlook de ' || email_alvo),
    'submitted_by_email', email_alvo,
    'active', true
  );
end;
$$;

revoke all on function public.flow_register_outlook_bridge(uuid,text,text,text)
  from public, anon;
grant execute on function public.flow_register_outlook_bridge(uuid,text,text,text)
  to authenticated;

create or replace function public.flow_list_outlook_bridges()
returns table (
  bridge_id uuid,
  label text,
  submitted_by_email text,
  active boolean,
  created_at timestamptz,
  rotated_at timestamptz,
  last_used_at timestamptz,
  last_result text,
  last_error text,
  revoked_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or public.flow_current_role() not in ('administrador', 'proprietario') then
    raise exception 'Somente administradores podem ver as pontes do Outlook.'
      using errcode = '42501';
  end if;

  return query
  select s.bridge_id, s.label, s.submitted_by_email, s.active,
         s.created_at, s.rotated_at, s.last_used_at,
         s.last_result, s.last_error, s.revoked_at
    from public.flow_external_webhook_secrets s
   where s.kind = 'outlook_local'
     and s.bridge_id is not null
   order by s.active desc, s.created_at desc;
end;
$$;

revoke all on function public.flow_list_outlook_bridges() from public, anon;
grant execute on function public.flow_list_outlook_bridges() to authenticated;

create or replace function public.flow_revoke_outlook_bridge(p_bridge_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or public.flow_current_role() not in ('administrador', 'proprietario') then
    raise exception 'Somente administradores podem revogar a ponte do Outlook.'
      using errcode = '42501';
  end if;

  update public.flow_external_webhook_secrets
     set active = false,
         revoked_at = now(),
         last_result = 'revogada',
         last_error = '',
         rotated_at = now()
   where bridge_id = p_bridge_id
     and kind = 'outlook_local';

  if not found then
    raise exception 'Ponte do Outlook não encontrada.' using errcode = 'P0002';
  end if;

  return jsonb_build_object('bridge_id', p_bridge_id, 'active', false);
end;
$$;

revoke all on function public.flow_revoke_outlook_bridge(uuid) from public, anon;
grant execute on function public.flow_revoke_outlook_bridge(uuid) to authenticated;

comment on function public.flow_register_outlook_bridge(uuid,text,text,text) is
  'Ativa uma ponte local usando apenas o hash produzido no Windows; somente para a administração.';
comment on function public.flow_list_outlook_bridges() is
  'Lista estado e última atividade das pontes locais sem expor hashes ou segredos.';
comment on function public.flow_revoke_outlook_bridge(uuid) is
  'Revoga uma credencial local sem alterar e-mails ou entradas já recebidas.';
comment on function public.flow_redact_external_inbox_batch(timestamptz,integer) is
  'Remove texto antigo em lotes pequenos para não alongar nem bloquear o recebimento.';

commit;
