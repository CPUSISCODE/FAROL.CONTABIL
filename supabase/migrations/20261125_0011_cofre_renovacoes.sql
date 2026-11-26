-- Cofre CPUSIS: operação de renovação de certificados (contato do cliente, situação, avisos dados).
alter table public.cofre
  add column if not exists contato_nome text,
  add column if not exists contato_fone text,
  add column if not exists contato_email text,
  add column if not exists renov_status text,          -- nao_avisado | avisado | negociando | agendado | renovado | outro | nao_renova
  add column if not exists renov_ref timestamptz,      -- validade do certificado quando a situação foi marcada (certificado novo = ciclo novo)
  add column if not exists renov_obs text,
  add column if not exists renov_aviso_em timestamptz,
  add column if not exists renov_aviso_por text,
  add column if not exists renov_avisos int not null default 0,
  add column if not exists renov_historico jsonb not null default '[]'::jsonb;   -- últimos 30 contatos
revoke all on public.cofre from anon, authenticated;
