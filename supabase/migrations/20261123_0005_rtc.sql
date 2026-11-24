-- Conferência IBS/CBS (reforma tributária) com a Calculadora de Tributos da Receita
create table if not exists rtc_tabela (chave text primary key, dados jsonb not null, atualizado_em timestamptz not null default now());
create table if not exists rtc_confirmacoes (chave text primary key, assinatura text, resultado jsonb, em timestamptz not null default now());
create table if not exists rtc_ncm (par text primary key, valido boolean, em timestamptz not null default now());
create table if not exists rtc_execucoes (id bigserial primary key, em timestamptz not null default now(), resultado jsonb);
alter table rtc_tabela enable row level security;
alter table rtc_confirmacoes enable row level security;
alter table rtc_ncm enable row level security;
alter table rtc_execucoes enable row level security;
revoke all on rtc_tabela, rtc_confirmacoes, rtc_ncm, rtc_execucoes from anon, authenticated;
create extension if not exists pg_cron;
-- o agendamento (cron.schedule) é criado fora do repositório, porque leva o token da função
create table if not exists rtc_config (id int primary key check (id = 1), token text not null);
alter table rtc_config enable row level security;
revoke all on rtc_config from anon, authenticated;
insert into rtc_config (id, token) values (1, encode(extensions.gen_random_bytes(24), 'hex')) on conflict (id) do nothing;
-- agendamentos: cron.schedule('rtc-confirmar-*', ...) chamando a função rtc com o token de rtc_config (07:15, 10:45 e 13:15 UTC)
