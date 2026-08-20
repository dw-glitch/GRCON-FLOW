-- GRCON Flow — normas, revisões e catálogos versionados.

create table if not exists public.flow_norms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  title text not null default '',
  scope text not null default 'qualidade',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.flow_norm_versions (
  id uuid primary key default gen_random_uuid(),
  norm_id uuid not null references public.flow_norms(id) on delete cascade,
  revision text not null,
  effective_date date,
  status text not null default 'rascunho' check (status in ('rascunho','ativa','substituida','erro')),
  file_name text not null default '',
  storage_path text not null default '',
  notes text not null default '',
  rules jsonb not null default '{}'::jsonb,
  error_message text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_by_name text not null default '',
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  unique (norm_id, revision)
);

create table if not exists public.flow_norm_catalog_entries (
  id uuid primary key default gen_random_uuid(),
  catalog_code text not null,
  entry_code text not null,
  label text not null default '',
  active boolean not null default true,
  revision_no integer not null default 1,
  source_norm_version_id uuid references public.flow_norm_versions(id) on delete set null,
  valid_from timestamptz not null default now(),
  superseded_at timestamptz,
  changed_by uuid references auth.users(id) on delete set null
);

create unique index if not exists flow_norm_catalog_current_uidx
  on public.flow_norm_catalog_entries (catalog_code, entry_code)
  where superseded_at is null;
create index if not exists flow_norm_versions_norm_idx on public.flow_norm_versions (norm_id, created_at desc);
create index if not exists flow_norm_catalog_active_idx
  on public.flow_norm_catalog_entries (catalog_code, entry_code)
  where superseded_at is null and active;

alter table public.flow_norms enable row level security;
alter table public.flow_norm_versions enable row level security;
alter table public.flow_norm_catalog_entries enable row level security;

drop policy if exists "normas visiveis a equipe" on public.flow_norms;
drop policy if exists "revisoes normativas visiveis a equipe" on public.flow_norm_versions;
drop policy if exists "catalogos visiveis a equipe" on public.flow_norm_catalog_entries;
create policy "normas visiveis a equipe" on public.flow_norms for select to authenticated using (public.flow_is_staff());
create policy "revisoes normativas visiveis a equipe" on public.flow_norm_versions for select to authenticated using (public.flow_is_staff());
create policy "catalogos visiveis a equipe" on public.flow_norm_catalog_entries for select to authenticated using (public.flow_is_staff());

revoke all on public.flow_norms, public.flow_norm_versions, public.flow_norm_catalog_entries from anon, authenticated;
grant select on public.flow_norms, public.flow_norm_versions, public.flow_norm_catalog_entries to authenticated;

create or replace function public.flow_list_norms()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare resultado jsonb;
begin
  if not public.flow_is_admin() then raise exception 'Somente administradores podem consultar o cadastro de normas.'; end if;
  select coalesce(jsonb_agg(
    to_jsonb(n) || jsonb_build_object('versoes', coalesce((
      select jsonb_agg(to_jsonb(v) order by v.created_at desc)
      from public.flow_norm_versions v where v.norm_id = n.id
    ), '[]'::jsonb)) order by n.code
  ), '[]'::jsonb) into resultado
  from public.flow_norms n where n.active;
  return resultado;
end;
$$;

create or replace function public.flow_active_code_rules()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare resultado jsonb;
begin
  if not public.flow_is_admin() then raise exception 'Somente administradores podem carregar regras de importação.'; end if;
  select jsonb_build_object(
    'schema_version', 1,
    'tipos_relatorio', coalesce((select jsonb_agg(entry_code order by entry_code) from public.flow_norm_catalog_entries where catalog_code='TIPOS_RELATORIO' and active and superseded_at is null), '[]'::jsonb),
    'categorias_n1710', coalesce((select jsonb_agg(entry_code order by entry_code) from public.flow_norm_catalog_entries where catalog_code='CATEGORIAS_N1710' and active and superseded_at is null), '[]'::jsonb),
    'disciplinas_relatorio', coalesce((select jsonb_agg(entry_code order by entry_code) from public.flow_norm_catalog_entries where catalog_code='DISCIPLINAS_RELATORIO' and active and superseded_at is null), '[]'::jsonb),
    'emissores', coalesce((select jsonb_agg(entry_code order by entry_code) from public.flow_norm_catalog_entries where catalog_code='EMISSORES_RELATORIO' and active and superseded_at is null), '[]'::jsonb),
    'unidades', coalesce((select jsonb_agg(entry_code order by entry_code) from public.flow_norm_catalog_entries where catalog_code='UNIDADES_RELATORIO' and active and superseded_at is null), '[]'::jsonb),
    'norm_versions', coalesce((select jsonb_agg(jsonb_build_object('code',n.code,'revision',v.revision,'effective_date',v.effective_date) order by n.code)
      from public.flow_norm_versions v join public.flow_norms n on n.id=v.norm_id where v.status='ativa' and n.active), '[]'::jsonb)
  ) into resultado;
  return resultado;
end;
$$;

create or replace function public.flow_create_norm_version(
  p_norm_code text, p_norm_title text, p_revision text, p_effective_date date,
  p_file_name text, p_notes text default '', p_rules jsonb default '{}'::jsonb
)
returns public.flow_norm_versions
language plpgsql
security definer
set search_path = public
as $$
declare norma uuid; nova public.flow_norm_versions;
begin
  if not public.flow_is_admin() then raise exception 'Somente administradores podem registrar normas.'; end if;
  if btrim(coalesce(p_norm_code,''))='' or btrim(coalesce(p_revision,''))='' then raise exception 'Informe norma e revisão.'; end if;
  if btrim(coalesce(p_file_name,''))='' then raise exception 'Anexe o PDF controlado da revisão.'; end if;
  insert into public.flow_norms (code,title) values (upper(btrim(p_norm_code)), btrim(coalesce(p_norm_title,'')))
  on conflict (code) do update set title=excluded.title, updated_at=now()
  returning id into norma;
  insert into public.flow_norm_versions (
    norm_id,revision,effective_date,status,file_name,notes,rules,created_by,created_by_name
  ) values (
    norma,btrim(p_revision),p_effective_date,'rascunho',btrim(p_file_name),coalesce(p_notes,''),
    coalesce(p_rules,'{}'::jsonb),auth.uid(),public.flow_current_name()
  ) returning * into nova;
  return nova;
exception when unique_violation then raise exception 'Esta revisão já está cadastrada para a norma.';
end;
$$;

create or replace function public.flow_set_norm_storage_path(target_version uuid, p_storage_path text)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.flow_is_admin() then raise exception 'Somente administradores podem vincular arquivos de normas.'; end if;
  update public.flow_norm_versions set storage_path=btrim(coalesce(p_storage_path,'')) where id=target_version and status='rascunho';
  if not found then raise exception 'Revisão normativa não encontrada ou fora de rascunho.'; end if;
end; $$;

create or replace function public.flow_fail_norm_version(target_version uuid, p_message text)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.flow_is_admin() then raise exception 'Somente administradores podem registrar falhas de normas.'; end if;
  update public.flow_norm_versions set status='erro',error_message=left(coalesce(p_message,''),500) where id=target_version and status='rascunho';
end; $$;

create or replace function public.flow_activate_norm_version(target_version uuid)
returns void language plpgsql security definer set search_path=public as $$
declare alvo public.flow_norm_versions;
begin
  if not public.flow_is_admin() then raise exception 'Somente administradores podem ativar normas.'; end if;
  select * into alvo from public.flow_norm_versions where id=target_version for update;
  if not found then raise exception 'Revisão normativa não encontrada.'; end if;
  if alvo.status not in ('rascunho','substituida','ativa') then raise exception 'Esta revisão não pode ser ativada.'; end if;
  if btrim(coalesce(alvo.storage_path,''))='' then raise exception 'O PDF controlado precisa estar armazenado antes da ativação.'; end if;
  update public.flow_norm_versions set status='substituida' where norm_id=alvo.norm_id and id<>target_version and status='ativa';
  update public.flow_norm_versions set status='ativa',activated_at=now(),error_message='' where id=target_version;
end; $$;

create or replace function public.flow_save_catalog_entry(
  p_catalog_code text, p_entry_code text, p_label text default '', p_active boolean default true
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare catalogo text:=upper(btrim(coalesce(p_catalog_code,'')));
        codigo text:=upper(btrim(coalesce(p_entry_code,''))); proxima integer;
begin
  if not public.flow_is_admin() then raise exception 'Somente administradores podem alterar códigos da qualidade.'; end if;
  if catalogo not in ('TIPOS_RELATORIO','CATEGORIAS_N1710','DISCIPLINAS_RELATORIO','EMISSORES_RELATORIO','UNIDADES_RELATORIO') then raise exception 'Catálogo desconhecido.'; end if;
  if codigo='' then raise exception 'Informe o código.'; end if;
  select coalesce(max(revision_no),0)+1 into proxima from public.flow_norm_catalog_entries where catalog_code=catalogo and entry_code=codigo;
  update public.flow_norm_catalog_entries set superseded_at=now()
   where catalog_code=catalogo and entry_code=codigo and superseded_at is null;
  insert into public.flow_norm_catalog_entries (catalog_code,entry_code,label,active,revision_no,changed_by)
  values (catalogo,codigo,coalesce(p_label,''),coalesce(p_active,true),proxima,auth.uid());
  return jsonb_build_object('catalog_code',catalogo,'entry_code',codigo,'active',coalesce(p_active,true),'revision_no',proxima);
end; $$;

create or replace function public.flow_list_catalog_entries(p_catalog_code text)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare resultado jsonb;
begin
  if not public.flow_is_admin() then raise exception 'Somente administradores podem consultar códigos da qualidade.'; end if;
  select coalesce(jsonb_agg(to_jsonb(e) order by e.entry_code),'[]'::jsonb) into resultado
  from public.flow_norm_catalog_entries e
  where e.catalog_code=upper(btrim(coalesce(p_catalog_code,''))) and e.superseded_at is null;
  return resultado;
end; $$;

revoke all on function public.flow_list_norms() from public,anon;
revoke all on function public.flow_active_code_rules() from public,anon;
revoke all on function public.flow_create_norm_version(text,text,text,date,text,text,jsonb) from public,anon;
revoke all on function public.flow_set_norm_storage_path(uuid,text) from public,anon;
revoke all on function public.flow_fail_norm_version(uuid,text) from public,anon;
revoke all on function public.flow_activate_norm_version(uuid) from public,anon;
revoke all on function public.flow_save_catalog_entry(text,text,text,boolean) from public,anon;
revoke all on function public.flow_list_catalog_entries(text) from public,anon;
grant execute on function public.flow_list_norms(), public.flow_active_code_rules(),
  public.flow_create_norm_version(text,text,text,date,text,text,jsonb), public.flow_set_norm_storage_path(uuid,text),
  public.flow_fail_norm_version(uuid,text), public.flow_activate_norm_version(uuid),
  public.flow_save_catalog_entry(text,text,text,boolean), public.flow_list_catalog_entries(text)
to authenticated,service_role;

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('flow-normas','flow-normas',false,52428800,array['application/pdf'])
on conflict (id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists "flow normas escrita" on storage.objects;
drop policy if exists "flow normas leitura" on storage.objects;
drop policy if exists "flow normas remocao" on storage.objects;
create policy "flow normas escrita" on storage.objects for insert to authenticated
  with check (bucket_id='flow-normas' and public.flow_is_admin());
create policy "flow normas leitura" on storage.objects for select to authenticated
  using (bucket_id='flow-normas' and public.flow_is_staff());
create policy "flow normas remocao" on storage.objects for delete to authenticated
  using (bucket_id='flow-normas' and public.flow_is_admin());

-- Revisões recebidas e classificadas no levantamento inicial. Arquivos não são
-- copiados para o repositório; o proprietário poderá anexar as cópias
-- controladas na tela de Normas.
with dados(code,title,scope,revision,effective_date,status,notes) as (values
  ('ET-5290.00-22000-912-1LV-001','Definição de codificação de documentos','codificacao','N',null::date,'substituida','Revisão histórica'),
  ('ET-5290.00-22000-912-1LV-001','Definição de codificação de documentos','codificacao','P',null::date,'substituida','Revisão histórica'),
  ('ET-5290.00-22000-912-1LV-001','Definição de codificação de documentos','codificacao','Q','2026-08-12'::date,'ativa','Revisão aprovada fornecida para a estrutura inicial'),
  ('N-1710','Codificação de documentos de engenharia','codificacao','N','2020-04-01'::date,'ativa','Anexos A a G cadastrados como referências da mesma norma'),
  ('N-0381','Execução de desenhos e outros documentos técnicos em geral','documentacao','M',null::date,'ativa','Inclui errata fornecida'),
  ('NBR 5419-1','Proteção contra descargas atmosféricas — Parte 1','referencia','2026','2026-04-02'::date,'ativa','Referência técnica'),
  ('NBR 5419-2','Proteção contra descargas atmosféricas — Parte 2','referencia','2026','2026-04-02'::date,'ativa','Referência técnica'),
  ('NBR 5419-3','Proteção contra descargas atmosféricas — Parte 3','referencia','2026','2026-04-02'::date,'ativa','Referência técnica'),
  ('NBR 5419-4','Proteção contra descargas atmosféricas — Parte 4','referencia','2026','2026-04-02'::date,'ativa','Referência técnica'),
  ('NBR 15749','Medição de resistência de aterramento e de potenciais na superfície do solo','referencia','2009',null::date,'ativa','Referência técnica'),
  ('ISO 9001','Sistemas de gestão da qualidade — requisitos','referencia','2015',null::date,'ativa','Arquivo recebido é tradução para treinamento; validar a cópia controlada antes de uso normativo')
), normas as (
  insert into public.flow_norms(code,title,scope)
  select distinct code,title,scope from dados
  on conflict(code) do update set title=excluded.title,scope=excluded.scope,updated_at=now()
  returning id,code
)
insert into public.flow_norm_versions(norm_id,revision,effective_date,status,notes,rules)
select n.id,d.revision,d.effective_date,d.status,d.notes,
       case when d.code='ET-5290.00-22000-912-1LV-001' and d.revision='Q'
         then '{"schema_version":1,"kind":"document_coding","issuer":"C1O","unit":"U32"}'::jsonb
         else '{}'::jsonb end
from dados d join normas n on n.code=d.code
on conflict(norm_id,revision) do nothing;

-- Catálogos compactos da N-1710 e da estrutura de relatórios.
insert into public.flow_norm_catalog_entries(catalog_code,entry_code,label)
select 'CATEGORIAS_N1710',code,'' from regexp_split_to_table($codes$
CE
CR
DB
DE
EC
ET
FD
IM
IS
LA
LD
LI
LO
MA
MC
MD
MO
PR
PT
RL
RM
CT
SIT
$codes$, E'\n') code where btrim(code)<>''
on conflict (catalog_code,entry_code) where superseded_at is null do nothing;

insert into public.flow_norm_catalog_entries(catalog_code,entry_code,label)
select 'DISCIPLINAS_RELATORIO',code,'' from regexp_split_to_table($codes$
ADC
ARR
DBU
CVL
CTO
CRS
CDR
DOC
ELE
REQ
ETF
FSC
FOR
GER
HVAC
INSP
INS
PDMS
MEC
DIN
EST
PLA
PRS
PRJ
QUA
SMS
SEG
SIS
SUP
TEL
TUB
$codes$, E'\n') code where btrim(code)<>''
on conflict (catalog_code,entry_code) where superseded_at is null do nothing;

insert into public.flow_norm_catalog_entries(catalog_code,entry_code,label) values
  ('EMISSORES_RELATORIO','C1O','CONSAG'),
  ('UNIDADES_RELATORIO','U32','Unidade 32')
on conflict (catalog_code,entry_code) where superseded_at is null do nothing;

-- Tipos de relatório extraídos da Tabela 13 da ET Rev. Q fornecida.
insert into public.flow_norm_catalog_entries(catalog_code,entry_code,label)
select 'TIPOS_RELATORIO',code,'' from regexp_split_to_table($codes$
ACCD
ARM
ATCT
BFENT
BOR
CCM
CCP
CERS
CHUMB
CICN
CIFF
CIM
CIME
CIME1
CIME2
CIP
CISMM
CLT
CONC
CONCPM
CONTROLTUB
CRCN
CRE
CRF
CRL
CRM
CRP
CRSDF
CRSMM
CSV
CTECRI
CTEE
CTF
CTFA
CTFI
CTME
CTMI
CTPE
CTPES
CTPT
DB
DCONC
DESEM
DIMAT
DIN
DR
DTAND
EAC
ENDR
EPEIR
EPS
EPSR
EVS
EVSJE
FLUXOG.SPIE
FORM
FVI
FVM
RRIMTI
RRIMTIR
IEISR
INSCOB
INSHS
INSMET
INSMOB
INSPL
INSREC
IP
IRIS
ITEMP
LAC
LALV
LARM
LCOMP
LP
LPCMT
LPISO
LPJE
LPR
LREVEST
LSBASE
LSBLE
MATAPL
MTAND
MTEM
PAR.SPIE
PCFEM
PETPE
PJSI
PMC
PMI
PMI.SPIE
PMIR
PPT
PSTC
RAEM
RAOEQPD
RAOEQPN
RAOMODD
RAOMODN
RAPFI
RAQ
RAQR
RARF
RARNF
RATMQ
RATMQR
RATP
RCCED
RCCEE
RCCES
RCCM
RCCTS
RCIMCR
RCIME
RDCD
RDIT
RDO
RDRF
RDSM
RECOMP
REIDT
REP
REPORT
REVS
RFAB
RID
RIDCPR
RIDDR
RIDGR
RIDR
RIDSR
RIDVR
RIE
RIFMAI
RIFMI
RIFP
RIFPNI
RIFPR
RIFRF
RIFRNF
GRACIM
RIGE
RII
RIIT
RIITR
RILICE
RILICT
RILITCE
RILITCT
RILM
RILTCI
RIMCD
RIMCV
RIMDT
RIMG
RIMHB
RIMIBP
RIMIBSE
RIMIBT
RIMICB
RIMICF
RIMICFU
RIMICJE
RIMICV
RIMIDB
RIMIDJ
RIMIDO
RIMIEE
RIMIES
RIMII
RIMILC
RIMILM
RIMIMA
RIMIMT
RIMIP
RIMIPN
RIMIPP
RIMIPT
RIMIRK
RIMIRS
RIMISE
RIMISPDA
RIMISW
RIMITB
RIMITBE
RIMITCB
RIMITCF
RIMITCJ
RIMITDB
RIMITDJ
RIMITE
RIMITEL
RIMITF
RIMITL
RIMITM
RIMITP
RIMITPI
RIMITR
RIMITS
RIMITT
RIMITTE
RIMITTS
RIMJ
RIMJBI
RIMPI
RIMPV
RIMS
RIMSE
RIMSI
RIMTET
RIMTU
RIMV
RIMVC
RIP
RIPBE
RIPSV
RIR
RIRP
RIRSS
RIR-STH
RIRV
RISI
RISI.EXT.INT.SPIE
RISI.INT.SPIE
RISOL
RITSR
RIVVT
RL
RLFAB
RLISOL
RLMANG
RLMTCL
RLPIN
RLRCD
RLREVEST
RLSUP
RMCME
RME
RMTCL
RMTPR
RMTVI
RNC
RPIN
RPL
RPLH
RPLS
RSOFT-CPS
RSOFT-DESC
RSOFT-SCMD
RSOFT-SDCD
RREMG
RRIDC
RRII
RRIMD
RRIMG
RRIMS
RRIMT
RRMCP
RRRF
RTA
RTACH-CPS
RTACH-SDCD
RTACS
RTACS-CPS
RTACS-SDCD
RTAFH-CPS
RTAFH-SDCD
RTAFS-CPS
RTAFS-DESC
RTAFS-SCMD
RTAFS-SDCD
RTAR
RTCFO
RTDBE
RTDBSE
RTDBT
RTDCB
RTDCE
RTDCF
RTDCFU
RTDCJE
RTDCJT
RTDCT
RTDCV
RTDDB
RTDDJ
RTDDO
RTDES
RTDLC
RTDLM
RTDMT
RTDPN
RTDPP
RTDRP
RTDRS
RTDSPDA
RTDSW
RTDTE
RTDTF
RTDTL
RTDTS
RTFCJI
RTIS
RTTAT
RUFF
RUS
SUP.MOLA.SPIE
TFEM
TH.SPIE
TREINCT
TREINPB
TTAS1
TTAS2
TTI
US
USJE
US-ME
US-ME.SPIE
$codes$, E'\n') code where btrim(code)<>''
on conflict (catalog_code,entry_code) where superseded_at is null do nothing;
