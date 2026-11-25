#!/usr/bin/env python3
"""Roda todo dia no GitHub (.github/workflows/receita.yml).

1. Remonta as regras de IBS/CBS (cClassTrib por NCM) a partir do código-fonte oficial da Calculadora de Tributos
   da Receita (calc/rtc_oficial.js e dados/rtc_oficial.json) e as calculadoras/motor do portal.
2. Compara com a versão anterior. Se a Receita mudou alguma coisa, registra a novidade em dados/rtc_novidades.json:
   classificações novas, removidas ou com descrição/redução diferente e, NCM por NCM (base de 10.687 NCMs das
   calculadoras), o que muda no enquadramento. O banco lê esse arquivo, cruza com o que cada cliente vende e o
   portal mostra o aviso para contadores e clientes.
3. Grava dados/receita_verificacao.json (última conferência), para saber que o robô está rodando.

Uso: python3 ferramentas/atualizar_receita.py <repo da Receita> <GUIA-SN> <GUIA-LP>
"""
import json, subprocess, sys, pathlib, datetime

RAIZ = pathlib.Path(__file__).resolve().parent.parent
REC, SN, LP = sys.argv[1:4]
git = lambda d: subprocess.run(['git', '-C', d, 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()
ARQ = RAIZ / 'dados' / 'rtc_oficial.json'
antes = json.loads(ARQ.read_text(encoding='utf-8')) if ARQ.exists() else None

subprocess.run([sys.executable, str(RAIZ / 'ferramentas' / 'montar_rtc_oficial.py'), REC, git(REC)], check=True)
subprocess.run([sys.executable, str(RAIZ / 'ferramentas' / 'montar_calc.py'), SN, LP, git(SN), git(LP)], check=True)
depois = json.loads(ARQ.read_text(encoding='utf-8'))
agora = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def aplicaveis(regras, ncm):
    out = []
    for g in regras:
        if ncm.startswith(g[0]) and not (len(g) > 2 and any(ncm.startswith(x) for x in g[2])) and g[1] not in out:
            out.append(g[1])
    return sorted(out)


novidade = None
if antes is not None:
    ca, cd = antes['classes'], depois['classes']
    classes = {
        'novas': [{'c': c, 'd': cd[c]['d'], 'r': cd[c]['r']} for c in sorted(set(cd) - set(ca))],
        'removidas': [{'c': c, 'd': ca[c]['d']} for c in sorted(set(ca) - set(cd))],
        'alteradas': [{'c': c, 'antes': ca[c], 'depois': cd[c]} for c in sorted(set(ca) & set(cd)) if ca[c] != cd[c]],
    }
    ncms = []
    if antes['regras'] != depois['regras']:
        base = json.loads(pathlib.Path(SN, 'supabase', 'seed', 'ncm.json').read_text(encoding='utf-8'))
        desc = {r.split('|')[0]: r.split('|')[1] for r in base['rows']}
        for n in sorted(desc):
            a, b = aplicaveis(antes['regras'], n), aplicaveis(depois['regras'], n)
            if a != b:
                ncms.append({'ncm': n, 'd': desc[n][:80], 'antes': a, 'depois': b})
    alteradas = set(x['c'] for x in classes['alteradas']) | set(x['c'] for x in classes['removidas'])
    if alteradas:   # NCMs de classificações que mudaram de redução/descrição também contam como afetados
        base = json.loads(pathlib.Path(SN, 'supabase', 'seed', 'ncm.json').read_text(encoding='utf-8'))
        ja = {x['ncm'] for x in ncms}
        for r in base['rows']:
            n = r.split('|')[0]
            cods = aplicaveis(depois['regras'], n)
            if n not in ja and set(cods) & alteradas:
                ncms.append({'ncm': n, 'd': r.split('|')[1][:80], 'antes': cods, 'depois': cods, 'classe_mudou': True})
    if any(classes.values()) or ncms:
        partes = []
        if classes['novas']: partes.append(str(len(classes['novas'])) + ' classificação(ões) nova(s)')
        if classes['alteradas']: partes.append(str(len(classes['alteradas'])) + ' com redução ou descrição alterada')
        if classes['removidas']: partes.append(str(len(classes['removidas'])) + ' removida(s)')
        if ncms: partes.append(str(len(ncms)) + ' NCM(s) com enquadramento diferente')
        novidade = {'id': agora[:10] + '-' + depois['base'], 'em': agora, 'base_antes': antes.get('base', ''), 'base_depois': depois['base'],
                    'commit': depois['commit'], 'fonte': depois['fonte'], 'resumo': '; '.join(partes), 'classes': classes,
                    'total_ncms': len(ncms), 'ncms': ncms[:3000]}

NOV = RAIZ / 'dados' / 'rtc_novidades.json'
hist = json.loads(NOV.read_text(encoding='utf-8')) if NOV.exists() else {'novidades': []}
if novidade:
    hist['novidades'] = [x for x in hist['novidades'] if x['id'] != novidade['id']][-19:] + [novidade]
    NOV.write_text(json.dumps(hist, ensure_ascii=False, indent=1), encoding='utf-8')
    print('NOVIDADE:', novidade['resumo'])
elif not NOV.exists():
    NOV.write_text(json.dumps(hist, ensure_ascii=False, indent=1), encoding='utf-8')
(RAIZ / 'dados' / 'receita_verificacao.json').write_text(json.dumps(
    {'verificado_em': agora, 'base': depois['base'], 'commit': depois['commit'], 'mudou': bool(novidade)}, ensure_ascii=False, indent=1), encoding='utf-8')
print('base', depois['base'], 'commit', depois['commit'], 'novidade' if novidade else 'sem mudança')
