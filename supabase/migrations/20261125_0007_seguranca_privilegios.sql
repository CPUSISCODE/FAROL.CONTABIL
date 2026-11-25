-- Aplicado em 25/11/2026 (seguranca_privilegios_padrao)
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated, public;
create or replace function public.limpar_tentativas() returns void language sql set search_path = '' as $$
  delete from public.tentativas_ip where ate < now() - interval '1 day';
  delete from public.tentativas_login where ate < now() - interval '1 day';
  delete from public.sessoes where expira_em < now() or (absoluta_ate is not null and absoluta_ate < now());
$$;
revoke execute on function public.limpar_tentativas() from anon, authenticated, public;
select cron.schedule('farol-limpar-sessoes', '40 9 * * *', 'select public.limpar_tentativas()');
