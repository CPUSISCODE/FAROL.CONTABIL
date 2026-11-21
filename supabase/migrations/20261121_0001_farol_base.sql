-- Farol Contábil: banco de dados (Supabase / PostgreSQL)
-- Dados ficam aqui; arquivos (ZIP dos XML, backups, comprovantes, OFX) continuam no Google Drive.
-- Acesso: SOMENTE pelas Edge Functions (chave de serviço). RLS ligado em todas as tabelas e
-- nenhuma política para anon/authenticated = ninguém lê nada direto pela chave pública.

create extension if not exists unaccent with schema extensions;

-- mesma normalização do receptor (normal_): sem acento, espaços simples, MAIÚSCULAS
create or replace function public.normal(t text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select upper(trim(regexp_replace(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(t, '')), '\s+', ' ', 'g')))
$$;

-- ---------------------------------------------------------------- acesso
create table public.usuarios (
  login            text primary key,                 -- minúsculo
  nome             text not null default '',
  contabs          text[] not null default '{}',     -- '*' = todas (CPUSIS)
  senha_hash       text not null default '',         -- formato do receptor: sal$hash (SHA-256 x300)
  ativo            boolean not null default true,
  ultimo_acesso    timestamptz,
  empresa_contab   text,                             -- login de empresa do BPO
  empresa_cliente  text,
  criado_em        timestamptz not null default now()
);

create table public.sessoes (
  token      text primary key,
  login      text not null references public.usuarios(login) on delete cascade,
  dados      jsonb not null,
  criado_em  timestamptz not null default now(),
  expira_em  timestamptz not null
);
create index on public.sessoes (expira_em);

create table public.tentativas_login (
  login text primary key, falhas int not null default 0, ate timestamptz not null default now()
);

create table public.acessos (
  id bigint generated always as identity primary key,
  em timestamptz not null default now(), login text, acao text, detalhe text
);
create index on public.acessos (em desc);

create table public.aparencia (chave text primary key, valor text not null default '');

-- ---------------------------------------------------------------- clientes e resumos fiscais
create table public.unidades (
  id             bigint generated always as identity primary key,
  contabilidade  text not null,
  cliente        text not null,
  subpasta       text not null default '',
  contab_n       text generated always as (public.normal(contabilidade)) stored,
  cliente_n      text generated always as (public.normal(cliente)) stored,
  subpasta_n     text generated always as (public.normal(subpasta)) stored,
  drive_pid      text,                               -- pasta do resumo no Drive (_PORTAL_DADOS)
  criado_em      timestamptz not null default now(),
  unique (contab_n, cliente_n, subpasta_n)
);

create table public.resumos (                        -- o AAAA-MM.json gerado pelo agente
  unidade_id     bigint not null references public.unidades(id) on delete cascade,
  mes            text not null check (mes ~ '^\d{4}-\d{2}$'),
  dados          jsonb not null,
  atualizado_em  timestamptz not null default now(),
  primary key (unidade_id, mes)
);

create table public.indicadores (                    -- números do painel, calculados do resumo
  unidade_id     bigint not null references public.unidades(id) on delete cascade,
  mes            text not null,
  dados          jsonb not null,
  atualizado_em  timestamptz not null default now(),
  primary key (unidade_id, mes)
);
create index on public.indicadores (mes);

create table public.regimes (
  contabilidade text not null, cliente text not null, regime text not null, obs text not null default '',
  contab_n text generated always as (public.normal(contabilidade)) stored,
  cliente_n text generated always as (public.normal(cliente)) stored,
  primary key (contab_n, cliente_n)
);

create table public.unificados (                     -- cliente duplicado -> cliente que ficou
  de_contab_n text not null, de_cliente_n text not null,
  para_contab text not null, para_cliente text not null,
  primary key (de_contab_n, de_cliente_n)
);

-- ---------------------------------------------------------------- envios (antes: abas Painel e Histórico)
create table public.envios (                         -- situação atual por cliente e mês
  contabilidade text not null, cliente text not null, mes text not null,
  contab_n text generated always as (public.normal(contabilidade)) stored,
  cliente_n text generated always as (public.normal(cliente)) stored,
  cnpj text, ultimo_contato timestamptz, situacao text, mensagem text, maquina text, versao text,
  dados jsonb not null default '{}',                  -- demais colunas do painel (quantidades, arquivo...)
  primary key (contab_n, cliente_n, mes)
);

create table public.historico (
  id bigint generated always as identity primary key,
  em timestamptz not null default now(), contabilidade text, cliente text, mes text,
  situacao text, arquivo text, tamanho_kb numeric, maquina text, mensagem text
);
create index on public.historico (em desc);

-- ---------------------------------------------------------------- servidores dos clientes
create table public.servidores (
  contabilidade text not null, cliente text not null,
  contab_n text generated always as (public.normal(contabilidade)) stored,
  cliente_n text generated always as (public.normal(cliente)) stored,
  maquina text, versao text, banco text, servico text,
  fazer_backup boolean not null default true, reiniciar boolean not null default false,
  ultimo_backup timestamptz, backup_mb numeric, sql_mb numeric, backup_situacao text, backup_msg text,
  ultimo_monitor timestamptz, monitor jsonb,
  acesso_remoto boolean not null default false, rustdesk_id text, rustdesk_senha text,
  dados jsonb not null default '{}', atualizado_em timestamptz not null default now(),
  primary key (contab_n, cliente_n)
);

create table public.eventos (
  id bigint generated always as identity primary key,
  em timestamptz not null default now(), contabilidade text, cliente text, maquina text,
  tipo text, detalhe text, segundos numeric, forcado boolean
);
create index on public.eventos (em desc);

create table public.comandos (
  id text primary key, pedido_em timestamptz not null default now(),
  contabilidade text not null, cliente text not null,
  contab_n text generated always as (public.normal(contabilidade)) stored,
  cliente_n text generated always as (public.normal(cliente)) stored,
  comando text not null, detalhe text, quem text,
  situacao text not null default 'pendente', resultado text, concluido_em timestamptz
);
create index on public.comandos (contab_n, cliente_n, situacao);

create table public.atualizacoes (
  id bigint generated always as identity primary key,
  em timestamptz not null default now(), oque text, de text, para text, resultado text
);

-- ---------------------------------------------------------------- BPO financeiro
create table public.bpo (
  id bigint generated always as identity primary key,
  contabilidade text not null, cliente text not null,
  contab_n text generated always as (public.normal(contabilidade)) stored,
  cliente_n text generated always as (public.normal(cliente)) stored,
  ativo boolean not null default true, inicio date, operador text not null default '', obs text not null default '',
  whatsapp text[] not null default '{}',
  ultimo_ofx timestamptz, pendencias int not null default 0, saldo numeric(14,2) not null default 0,
  atualizado_em timestamptz not null default now(),
  unique (contab_n, cliente_n)
);

create table public.fin_contas (
  bpo_id bigint not null references public.bpo(id) on delete cascade,
  conta_id text not null,                            -- banco-agencia-conta
  banco text, nome text, agencia text, conta text,
  saldo numeric(14,2), data_saldo text, ultima_importacao timestamptz,
  primary key (bpo_id, conta_id)
);

create table public.fin_lancamentos (
  bpo_id bigint not null, conta_id text not null, id text not null,
  mes text not null, data date not null, valor numeric(14,2) not null,
  descr text not null default '', doc text not null default '',
  cat text not null default '', orig text not null default '',
  st text not null default 'pend' check (st in ('ok', 'pend', 'cliente', 'just')),
  extra jsonb not null default '{}',                 -- justificativa, pergunta, anexo, comprovante ligado...
  atualizado_em timestamptz not null default now(),
  primary key (bpo_id, conta_id, id),
  foreign key (bpo_id, conta_id) references public.fin_contas(bpo_id, conta_id) on delete cascade
);
create index on public.fin_lancamentos (bpo_id, mes);
create index on public.fin_lancamentos (bpo_id, st) where st <> 'ok';
create index on public.fin_lancamentos (bpo_id, data, valor);

create table public.fin_regras (
  bpo_id bigint not null references public.bpo(id) on delete cascade,
  chave text not null, sinal text not null default '', cat text not null,
  criado_em timestamptz not null default now(),
  primary key (bpo_id, chave, sinal)
);

create table public.fin_comprovantes (
  bpo_id bigint not null references public.bpo(id) on delete cascade,
  id text not null, st text, dados jsonb not null,
  criado_em timestamptz not null default now(),
  primary key (bpo_id, id)
);
create index on public.fin_comprovantes (bpo_id, st);

-- ---------------------------------------------------------------- segurança: tudo fechado para a chave pública
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
revoke execute on function public.normal(text) from anon, authenticated;

-- limpeza de sessões vencidas (chamada pelas funções)
create or replace function public.limpar_sessoes() returns void language sql set search_path = '' as $$
  delete from public.sessoes where expira_em < now();
  delete from public.tentativas_login where ate < now() - interval '1 day';
$$;
revoke execute on function public.limpar_sessoes() from anon, authenticated, public;

-- meses com lançamentos de um cliente do BPO
create or replace function public.fin_meses(p_bpo bigint) returns table (mes text)
language sql stable set search_path = '' as $$
  select distinct l.mes from public.fin_lancamentos l where l.bpo_id = p_bpo
$$;
revoke execute on function public.fin_meses(bigint) from anon, authenticated, public;

-- histórico: a mesma linha nunca entra duas vezes, mesmo se o receptor reenviar
create unique index if not exists historico_unica on public.historico (em, coalesce(contabilidade,''), coalesce(cliente,''), coalesce(mes,''), coalesce(situacao,''));
create or replace function public.historico_ignorar_repetido() returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.historico h where h.em = new.em and coalesce(h.contabilidade,'') = coalesce(new.contabilidade,'')
             and coalesce(h.cliente,'') = coalesce(new.cliente,'') and coalesce(h.mes,'') = coalesce(new.mes,'') and coalesce(h.situacao,'') = coalesce(new.situacao,'')) then
    return null;
  end if;
  return new;
end $$;
drop trigger if exists historico_repetido on public.historico;
create trigger historico_repetido before insert on public.historico for each row execute function public.historico_ignorar_repetido();
revoke execute on function public.historico_ignorar_repetido() from anon, authenticated, public;
