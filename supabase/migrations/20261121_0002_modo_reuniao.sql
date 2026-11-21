-- Modo Reunião e termômetro fiscal (aplicado no Supabase em 21/11/2026: modo_reuniao + modo_reuniao_transferencias)
CREATE OR REPLACE FUNCTION public.reuniao_mes(d jsonb)
 RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path TO ''
AS $function$
  with t as (select x from jsonb_array_elements(coalesce(d->'tributacao', '[]'::jsonb)) x),
  v as (
    select
      coalesce(sum((x->>'valor')::numeric) filter (where x->>'es' = 'S' and x->>'origem' in ('NFe','NFCe')
        and x->>'cfop' ~ '^([56](1(0[1-9]|1[0-9]|20)|40[1-5]|6(5[1-9]|6[0-7]))|7(1(0[1-9]|1[0-9]|2[0-7])|50[12]|6(5[1-9]|6[0-7])))$'), 0) as vendas_brutas,
      coalesce(sum((x->>'valor')::numeric) filter (where x->>'es' = 'S' and x->>'origem' in ('NFe','NFCe') and x->>'cfop' ~ '^[56](15[1-2]|40[89]|65[89])$'), 0) as transf,
      coalesce(sum((x->>'valor')::numeric) filter (where x->>'es' = 'E' and x->>'cfop' ~ '^[12](20[1-2]|41[01])$'), 0) as devolucoes,
      coalesce(sum((x->>'valor')::numeric) filter (where x->>'es' = 'E' and x->>'origem' = 'Compras'
        and x->>'cfop' ~ '^[56](1(0[1-9]|1[0-9]|20)|40[1-5]|6(5[1-9]|6[0-7]))$'), 0) as compras_rev,
      coalesce(sum((x->>'valor')::numeric) filter (where x->>'es' = 'E' and x->>'origem' = 'Compras' and x->>'cfop' ~ '^[56](15[1-2]|40[89]|65[89])$'), 0) as transf_rec,
      coalesce(sum((x->>'valor')::numeric) filter (where x->>'es' = 'E' and x->>'origem' = 'Compras'), 0) as compras_todas,
      coalesce(sum(coalesce((x->>'vICMS')::numeric,0) + coalesce((x->>'vST')::numeric,0) + coalesce((x->>'vPIS')::numeric,0) + coalesce((x->>'vCOFINS')::numeric,0) + coalesce((x->>'vIPI')::numeric,0))
        filter (where x->>'es' = 'S' and x->>'origem' in ('NFe','NFCe')), 0) as impostos
    from t
  ),
  dia as (
    select extract(isodow from (p->>'dia')::date)::int as dw, sum(coalesce((p->>'vNfce')::numeric,0) + coalesce((p->>'vNfe')::numeric,0)) as v
    from jsonb_array_elements(coalesce(d->'porDia', '[]'::jsonb)) p where (p->>'dia') ~ '^\d{4}-\d{2}-\d{2}$' group by 1
  ),
  pg as (
    select coalesce(p->>'forma', 'Outros') as forma, sum((p->>'valor')::numeric) as v
    from jsonb_array_elements(coalesce(d->'pagamentos', '[]'::jsonb)) p group by 1
  )
  select jsonb_build_object(
    'vendas', round(v.vendas_brutas - v.devolucoes, 2), 'devolucoes', round(v.devolucoes, 2), 'transferencias', round(v.transf, 2),
    'comprasRevenda', round(v.compras_rev, 2), 'transfRecebidas', round(v.transf_rec, 2), 'comprasTodas', round(v.compras_todas, 2), 'impostos', round(v.impostos, 2),
    'nfceQtd', coalesce((d->'totais'->'NFCe'->>'qtd')::numeric, 0), 'nfceValor', coalesce((d->'totais'->'NFCe'->>'valor')::numeric, 0),
    'nfeQtd', coalesce((d->'totais'->'NFe'->>'qtd')::numeric, 0), 'nfeValor', coalesce((d->'totais'->'NFe'->>'valor')::numeric, 0),
    'crt', d->>'crt',
    'semana', (select jsonb_object_agg(dw, round(dia.v, 2)) from dia),
    'pagamentos', (select jsonb_object_agg(forma, round(pg.v, 2)) from pg)
  ) from v
$function$;

CREATE OR REPLACE FUNCTION public.reuniao(p_unidade bigint, p_mes text)
 RETURNS TABLE(mes text, n jsonb, ind jsonb) LANGUAGE sql STABLE SET search_path TO ''
AS $function$
  select r.mes, public.reuniao_mes(r.dados), i.dados - 'falhasLista' - 'pendencias' - 'rf'
       || jsonb_build_object('rf', (i.dados->'rf') - 'semGrupo')
  from public.resumos r left join public.indicadores i on i.unidade_id = r.unidade_id and i.mes = r.mes
  where r.unidade_id = p_unidade and r.mes <= p_mes and r.mes > to_char((p_mes || '-01')::date - interval '12 months', 'YYYY-MM')
  order by r.mes
$function$;

CREATE OR REPLACE FUNCTION public.termometro(p_unidades bigint[], p_mes text, p_janela integer DEFAULT 12)
 RETURNS TABLE(unidade_id bigint, meses integer, vendas numeric, transferencias numeric, compras numeric, transf_recebidas numeric)
 LANGUAGE sql STABLE SET search_path TO ''
AS $function$
  with m as (select r.unidade_id, public.reuniao_mes(r.dados) n from public.resumos r
    where r.unidade_id = any(p_unidades) and r.mes <= p_mes and r.mes > to_char((p_mes || '-01')::date - make_interval(months => p_janela), 'YYYY-MM'))
  select unidade_id, count(*)::int, sum((n->>'vendas')::numeric), sum((n->>'transferencias')::numeric), sum((n->>'comprasRevenda')::numeric), sum((n->>'transfRecebidas')::numeric)
  from m group by unidade_id
$function$;

revoke all on function public.reuniao_mes(jsonb), public.reuniao(bigint, text), public.termometro(bigint[], text, integer) from public, anon, authenticated;
