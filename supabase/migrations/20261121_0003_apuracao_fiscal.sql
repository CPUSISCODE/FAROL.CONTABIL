-- Apuração fiscal estimada (aba "Apuração fiscal" da tela do cliente). Aplicado no Supabase em 21/11/2026 (apuracao_fiscal).
create or replace function public.apuracao_mes(d jsonb)
returns jsonb language sql immutable parallel safe set search_path to ''
as $function$
  with t as (select x from jsonb_array_elements(coalesce(d->'tributacao', '[]'::jsonb)) x),
  pc as (select x from jsonb_array_elements(coalesce(d->'pisCofins', '[]'::jsonb)) x where x->>'origem' in ('NFe','NFCe')),
  a as (
    select
      coalesce(sum(coalesce((x->>'vICMS')::numeric,0)) filter (where x->>'es' = 'S'), 0) as icms_deb,
      coalesce(sum(coalesce((x->>'vICMS')::numeric,0)) filter (where x->>'es' = 'E'), 0) as icms_cred,
      coalesce(sum(coalesce((x->>'vICMS')::numeric,0)) filter (where x->>'es' = 'S' and x->>'origem' in ('NFe','NFCe')
        and x->>'cfop' ~ '^([56](1(0[1-9]|1[0-9]|20)|40[1-5]|6(5[1-9]|6[0-7]))|7(1(0[1-9]|1[0-9]|2[0-7])|50[12]|6(5[1-9]|6[0-7])))$'), 0) as icms_vendas,
      coalesce(sum((x->>'valor')::numeric) filter (where x->>'es' = 'S' and x->>'origem' in ('NFe','NFCe') and x->>'cst' in ('60','500')
        and x->>'cfop' ~ '^[567](10[1-9]|11\d|12[0-5]|40[1-5]|50[12])$'), 0) as st_subst
    from t
  ),
  p as (
    select
      coalesce(sum((x->>'valor')::numeric) filter (where x->>'cstPis' in ('01','02','03')), 0) as trib,
      coalesce(sum((x->>'valor')::numeric) filter (where x->>'cstPis' in ('04','05','06','07','08','09')), 0) as nao_trib,
      coalesce(sum((x->>'valor')::numeric) filter (where x->>'cstPis' = '04'), 0) as mono,
      coalesce(sum(coalesce((x->>'vPIS')::numeric,0)) filter (where (x->>'cstPis') < '50'), 0) as pis_dest,
      coalesce(sum(coalesce((x->>'vCOFINS')::numeric,0)) filter (where (x->>'cstPis') < '50'), 0) as cofins_dest
    from pc
  )
  select jsonb_build_object('icmsDeb', round(a.icms_deb, 2), 'icmsCred', round(a.icms_cred, 2), 'icmsVendas', round(a.icms_vendas, 2), 'stSubst', round(a.st_subst, 2),
    'pcTrib', round(p.trib, 2), 'pcNaoTrib', round(p.nao_trib, 2), 'pcMono', round(p.mono, 2), 'pisDest', round(p.pis_dest, 2), 'cofinsDest', round(p.cofins_dest, 2))
  from a, p
$function$;

create or replace function public.apuracao(p_unidade bigint, p_mes text)
returns table(mes text, n jsonb, ap jsonb, ind jsonb)
language sql stable set search_path to ''
as $function$
  select r.mes, public.reuniao_mes(r.dados), public.apuracao_mes(r.dados),
         jsonb_build_object('regime', i.dados->'regime', 'devVenda', i.dados->'devVenda', 'monofasico', i.dados->'monofasico')
  from public.resumos r left join public.indicadores i on i.unidade_id = r.unidade_id and i.mes = r.mes
  where r.unidade_id = p_unidade and r.mes <= p_mes and r.mes > to_char((p_mes || '-01')::date - interval '24 months', 'YYYY-MM')
  order by r.mes
$function$;

revoke all on function public.apuracao_mes(jsonb), public.apuracao(bigint, text) from public, anon, authenticated;
