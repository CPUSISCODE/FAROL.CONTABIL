-- Acessos, perfis e permissões (25/11/2026). Só acrescenta; não apaga nada.
-- Perfis: admin (CPUSIS, tudo) · cpusis (operador CPUSIS: vê todas as contabilidades, não mexe em logins)
--         gestor (contabilidade: vê as suas e cria logins de contador/cliente delas) · contador · cliente (só a própria empresa)
alter table public.usuarios
  add column if not exists perfil text,
  add column if not exists modulos text[],                  -- null = padrão do perfil
  add column if not exists clientes text[],                 -- perfil cliente: 'CONTAB_N|CLIENTE_N' que pode ver
  add column if not exists trocar_senha boolean not null default false,
  add column if not exists senha_em timestamptz,
  add column if not exists criado_por text,
  add column if not exists email text,
  add column if not exists obs text;
update public.usuarios set perfil = case when '*' = any(contabs) then 'admin' when empresa_contab is not null then 'cliente' else 'contador' end where perfil is null;
alter table public.usuarios alter column perfil set default 'contador';
alter table public.usuarios drop constraint if exists usuarios_perfil_ck;
alter table public.usuarios add constraint usuarios_perfil_ck check (perfil in ('admin','cpusis','gestor','contador','cliente'));

alter table public.sessoes
  add column if not exists ip text,
  add column if not exists agente text,
  add column if not exists absoluta_ate timestamptz,
  add column if not exists visto_em timestamptz;

alter table public.acessos add column if not exists ip text;
create index if not exists acessos_em_idx on public.acessos(em desc);

create table if not exists public.tentativas_ip (ip text primary key, falhas int not null default 0, ate timestamptz not null default now());

create table if not exists public.portal_config (chave text primary key, valor jsonb, atualizado_em timestamptz default now());
insert into public.portal_config(chave, valor) values ('usuarios_no_banco', 'true'::jsonb) on conflict (chave) do nothing;

-- base fiscal das calculadoras (GUIA-SN / GUIA-LP): NCM, segmento de ST do Acre, MVA, monofásico
create table if not exists public.ncm_base (ncm text primary key check (ncm ~ '^[0-9]{8}$'), descricao text not null, segmento text, mva numeric(6,2), monofasico text);
create table if not exists public.ncm_base_versao (id boolean primary key default true check (id), versao text, fonte text, total int, atualizado_em timestamptz default now());

alter table public.tentativas_ip enable row level security;
alter table public.portal_config enable row level security;
alter table public.ncm_base enable row level security;
alter table public.ncm_base_versao enable row level security;
revoke all on public.tentativas_ip, public.portal_config, public.ncm_base, public.ncm_base_versao from anon, authenticated;
