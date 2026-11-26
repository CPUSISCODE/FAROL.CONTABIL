-- Cofre CPUSIS: CSC e certificado digital A1 (arquivo + senha) de cada unidade.
-- Os segredos chegam aqui já criptografados pela função "farol" (AES-256-GCM); a chave fica só no segredo
-- COFRE_CHAVE da função, nunca no banco. Só a função (service role) lê esta tabela.
create table if not exists public.cofre (
  unidade_id bigint primary key references public.unidades(id) on delete cascade,
  csc_id text,                       -- identificador do CSC (ex.: 000001), não é segredo
  csc_cifrado text,
  cert_senha_cifrada text,
  cert_pfx_cifrado text,
  cert_arquivo text,                 -- nome original do arquivo .pfx
  cert_inicio timestamptz,
  cert_validade timestamptz,
  cert_titular text,
  cert_doc text,                     -- CNPJ/CPF lido do certificado
  obs text,
  atualizado_por text,
  atualizado_em timestamptz not null default now()
);
alter table public.cofre enable row level security;
revoke all on public.cofre from anon, authenticated;
