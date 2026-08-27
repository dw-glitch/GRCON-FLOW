-- GRCON Flow — aviso individual no Microsoft Teams ao atribuir responsável.
-- O endpoint do Power Automate NÃO fica neste arquivo: ele é mantido
-- criptografado no Supabase Vault com o nome flow_teams_workflow_url.
--
-- O pg_net apenas enfileira a chamada HTTP após o commit. Assim, indisponibilidade
-- do Teams ou do Power Automate não bloqueia a atualização da solicitação.

create extension if not exists pg_net with schema extensions;

create or replace function public.flow_notify_assigned_responsible()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $function$
declare
  v_email text;
  v_webhook_url text;
  v_priority text;
  v_due text;
begin
  if new.owner_profile_id is null
     or new.owner_profile_id is not distinct from old.owner_profile_id then
    return new;
  end if;

  -- A central interna continua sendo a primeira contingência.
  insert into public.flow_notifications (user_id, request_id, kind, title, body)
  values (
    new.owner_profile_id,
    new.id,
    'atividade_atribuida',
    'Nova atividade atribuída · ' || new.protocol,
    concat_ws(
      ' · ',
      nullif(new.type_label, ''),
      nullif(new.summary, ''),
      case when new.due_at is not null
        then 'Prazo ' || to_char(new.due_at, 'DD/MM/YYYY')
      end
    )
  );

  -- Teams é uma integração auxiliar: qualquer falha fica isolada e nunca
  -- desfaz a atribuição nem a notificação interna.
  begin
    select p.email
      into v_email
      from public.flow_profiles p
     where p.id = new.owner_profile_id
       and p.active
     limit 1;

    select s.decrypted_secret
      into v_webhook_url
      from vault.decrypted_secrets s
     where s.name = 'flow_teams_workflow_url'
     order by s.created_at desc
     limit 1;

    if nullif(trim(v_email), '') is null
       or nullif(trim(v_webhook_url), '') is null then
      return new;
    end if;

    v_priority := case lower(coalesce(new.priority, ''))
      when 'urgente' then 'Urgente'
      when 'alta' then 'Alta'
      when 'baixa' then 'Baixa'
      else 'Normal'
    end;
    v_due := coalesce(to_char(new.due_at, 'DD/MM/YYYY'), 'Não definido');

    perform net.http_post(
      url := v_webhook_url,
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object(
        'responsible_email', v_email,
        'protocol', new.protocol,
        'type_label', coalesce(nullif(new.type_label, ''), 'Solicitação'),
        'summary', coalesce(nullif(new.summary, ''), 'Sem resumo'),
        'priority', v_priority,
        'due_at', v_due,
        'request_url', 'https://grcon-flow.vercel.app/painel'
      ),
      timeout_milliseconds := 5000
    );
  exception
    when others then
      raise warning 'GRCON Flow Teams notification was not queued: %', sqlerrm;
  end;

  return new;
end;
$function$;

-- A função existe somente para o trigger; não é um RPC do aplicativo.
revoke all on function public.flow_notify_assigned_responsible()
  from public, anon, authenticated;
