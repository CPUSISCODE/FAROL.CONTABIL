-- Revisão de segurança 21/11/2026 (aplicado no Supabase: seguranca_revogar_normal, seguranca_net_e_service_role)
revoke all on function public.normal(text) from public, anon, authenticated;
grant execute on function public.normal(text) to service_role;
create index if not exists sessoes_login_idx on public.sessoes(login);
revoke execute on all functions in schema net from anon, authenticated, public;
revoke usage on schema net from anon, authenticated;
grant usage on schema net to postgres, service_role;
grant execute on all functions in schema net to postgres, service_role;
