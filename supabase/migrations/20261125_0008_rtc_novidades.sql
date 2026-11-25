-- Aplicado em 25/11/2026 (rtc_novidades_impacto): novidades da Receita na tabela de IBS/CBS e clientes afetados.
-- Ver supabase/functions/rtc/main.ts (acoes 'novidades' e 'avisos') e .github/workflows/receita.yml.
create table if not exists public.rtc_novidades (id text primary key, em timestamptz not null default now(), dados jsonb not null, processada_em timestamptz);
create table if not exists public.rtc_impacto (unidade_id bigint not null references public.unidades(id) on delete cascade, novidade_id text not null references public.rtc_novidades(id) on delete cascade,
  mes text, ncms jsonb not null, primary key (unidade_id, novidade_id));
alter table public.rtc_novidades enable row level security;
alter table public.rtc_impacto enable row level security;
revoke all on public.rtc_novidades, public.rtc_impacto from anon, authenticated;
-- função rtc_calcular_impacto(p_id, p_ncms): ver o banco (cruza NCMs alterados com as saídas do último mês de cada cliente)
-- agendamento: 'rtc-novidades' às 10:40 UTC (06:40 no Acre), depois do robô do GitHub (09:17 UTC)
