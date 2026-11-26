-- Pendências fiscais marcadas como concluídas à mão (o portal não achou a solução nos XML, mas alguém resolveu).
-- chave: tipo|modelo|serie|numero (pendência) ou falha|modelo|serie|de|ate (numeração pulada).
create table if not exists public.pendencias_baixa (
  unidade_id bigint not null references public.unidades(id) on delete cascade,
  mes text not null,
  chave text not null,
  descricao text,
  obs text,
  por text not null,
  em timestamptz not null default now(),
  primary key (unidade_id, mes, chave)
);
alter table public.pendencias_baixa enable row level security;
revoke all on public.pendencias_baixa from anon, authenticated;
