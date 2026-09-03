-- Exportada de supabase_migrations.schema_migrations em 03/09/2026.
-- Versão aplicada: 20260819205414.
--
-- Este arquivo é o SQL que de fato criou os objetos no projeto — não uma
-- reconstrução a partir do schema. Ele estava aplicado no banco mas nunca
-- havia sido versionado, o que impedia montar uma instalação nova (ou um
-- ambiente de homologação) a partir do repositório.
--
-- Não edite para corrigir comportamento: uma migração já aplicada é
-- histórico. Mudança de regra entra numa migração nova.

-- GRCON Flow — isolamento dos dados.
-- O solicitante enxerga apenas o que ele mesmo pediu. Operador, administrador
-- e proprietário enxergam a operação inteira.

alter table public.flow_requests enable row level security;
alter table public.flow_request_items enable row level security;
alter table public.flow_triage_runs enable row level security;
alter table public.flow_history enable row level security;
alter table public.flow_comments enable row level security;
alter table public.flow_attachments enable row level security;
alter table public.flow_notifications enable row level security;
alter table public.flow_settings enable row level security;

-- Uma solicitação é visível ao seu autor ou a quem trabalha nela.
create or replace function public.flow_can_see_request(target_request uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.flow_requests r
    where r.id = target_request
      and (r.requester_id = auth.uid() or public.flow_is_staff())
  )
$$;

-- Solicitações -------------------------------------------------------------
create policy "solicitacoes visiveis" on public.flow_requests
for select using (requester_id = auth.uid() or public.flow_is_staff());

-- Qualquer usuário autenticado registra a própria solicitação. A gravação real
-- passa pela RPC flow_create_request, que também gera o protocolo.
create policy "solicitacoes criadas pelo autor" on public.flow_requests
for insert with check (requester_id = auth.uid() or public.flow_is_staff());

-- Depois de enviada, quem altera é a equipe. O solicitante acompanha.
create policy "solicitacoes alteradas pela equipe" on public.flow_requests
for update using (public.flow_is_staff()) with check (public.flow_is_staff());

create policy "solicitacoes removidas pelo administrador" on public.flow_requests
for delete using (public.flow_is_admin());

-- Itens --------------------------------------------------------------------
create policy "itens visiveis" on public.flow_request_items
for select using (public.flow_can_see_request(request_id));

create policy "itens criados com a solicitacao" on public.flow_request_items
for insert with check (public.flow_can_see_request(request_id));

create policy "itens alterados pela equipe" on public.flow_request_items
for update using (public.flow_is_staff()) with check (public.flow_is_staff());

create policy "itens removidos pelo administrador" on public.flow_request_items
for delete using (public.flow_is_admin());

-- Triagens -----------------------------------------------------------------
create policy "triagens visiveis" on public.flow_triage_runs
for select using (public.flow_can_see_request(request_id));

create policy "triagens gravadas pela equipe" on public.flow_triage_runs
for insert with check (public.flow_is_staff());

-- Histórico ----------------------------------------------------------------
-- Só recebe inserção: nada atualiza nem apaga um evento já registrado.
create policy "historico visivel" on public.flow_history
for select using (request_id is null or public.flow_can_see_request(request_id));

create policy "historico gravado" on public.flow_history
for insert with check (auth.uid() is not null);

-- Comentários --------------------------------------------------------------
-- Comentário interno é conversa da equipe; o solicitante não vê.
create policy "comentarios visiveis" on public.flow_comments
for select using (
  public.flow_is_staff()
  or (not internal and public.flow_can_see_request(request_id))
);

create policy "comentarios escritos pela equipe" on public.flow_comments
for insert with check (public.flow_is_staff() and author_id = auth.uid());

create policy "comentario proprio editavel" on public.flow_comments
for update using (author_id = auth.uid()) with check (author_id = auth.uid());

create policy "comentario removido pelo autor ou admin" on public.flow_comments
for delete using (author_id = auth.uid() or public.flow_is_admin());

-- Anexos -------------------------------------------------------------------
create policy "anexos visiveis" on public.flow_attachments
for select using (public.flow_can_see_request(request_id));

create policy "anexos enviados" on public.flow_attachments
for insert with check (public.flow_can_see_request(request_id) and uploaded_by = auth.uid());

create policy "anexos removidos" on public.flow_attachments
for delete using (uploaded_by = auth.uid() or public.flow_is_admin());

-- Notificações -------------------------------------------------------------
create policy "notificacoes proprias" on public.flow_notifications
for select using (user_id = auth.uid());

create policy "notificacoes marcadas como lidas" on public.flow_notifications
for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "notificacoes criadas pela equipe" on public.flow_notifications
for insert with check (public.flow_is_staff());

-- Configurações ------------------------------------------------------------
create policy "configuracoes legiveis" on public.flow_settings
for select using (auth.uid() is not null);

create policy "configuracoes administraveis" on public.flow_settings
for all using (public.flow_is_admin()) with check (public.flow_is_admin());
