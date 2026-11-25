#!/usr/bin/env python3
"""Monta calc/sn.html e calc/lp.html (calculadoras dentro do portal Farol Contábil) a partir dos
repositórios GUIA-SN e GUIA-LP, sem mudar as regras fiscais deles:
  - tira o login próprio (Supabase dos guias) e o histórico de XML na conta;
  - entra no lugar a "ponte" do Farol: usa o login do portal, baixa a base NCM do banco do Farol,
    recebe XML do portal (espelho da nota de compra) e põe a logo da CPUSIS na impressão.
Uso: python3 ferramentas/montar_calc.py <pasta GUIA-SN> <pasta GUIA-LP> <commit-sn> <commit-lp>
"""
import re, sys, base64, pathlib

RAIZ = pathlib.Path(__file__).resolve().parent.parent
PONTE = (RAIZ / 'ferramentas' / 'calc_ponte.js').read_text(encoding='utf-8')

def montar(src, saida, regime, commit):
    s = pathlib.Path(src, 'index.html').read_text(encoding='utf-8')
    n0 = len(s)
    # 1) biblioteca do Supabase dos guias
    s, n = re.subn(r'<script src="https://cdn\.jsdelivr\.net/npm/@supabase/supabase-js@[^"]+"></script>\s*', '', s); assert n == 1, 'supabase-js'
    # 2) histórico de XML na conta do guia -> substituto local
    pref = 'sn' if regime == 'SN' else 'lp'
    stub = ('<script>window.%sXmlArchive={maxBytes:5*1024*1024,getUserId:function(){return "farol";},setUser:function(){},'
            'save:function(){return Promise.resolve("Nota lida. No Farol o XML não é guardado na calculadora: ele fica na pasta do cliente.");},'
            'refresh:function(){}};</script>' % pref)
    s, n = re.subn(r'<script src="xml-archive\.js"></script>', stub, s); assert n == 1, 'xml-archive'
    # 2b) coluna "ICMS entrada" da importação de XML: mostra sempre a situação do ICMS na entrada
    #     (ST retida, antecipação com/sem encerramento, cesta básica, compra interna) e não o CBS/IBS da nota
    if regime == 'SN':
        velho = """'<td class="num">' + brl(row.entrada.icms) + (row.entrada.icms > 0 && row.entrada.aliqLabel ? '<br><span class="hint" style="margin:0;">' + row.entrada.aliqLabel + '</span>' : '') + ((item.vIBS||0)+(item.vCBS||0) > 0 ? '<br><span class="hint" style="margin:0;">CBS+IBS: ' + brl((item.vIBS||0)+(item.vCBS||0)) + ' (teste)</span>' : '') + '</td>' +"""
    else:
        velho = """'<td class="num">' + brl(row.entrada.icms) + '</td>' +"""
    novo = """'<td class="num">' + brl(row.entrada.icms) + (row.entrada.aliqLabel ? '<br><span class="hint farol-icms-ent" style="margin:0;">' + row.entrada.aliqLabel + '</span>' : '') + '</td>' +"""
    assert s.count(velho) == 1, 'coluna ICMS entrada'
    s = s.replace(velho, novo)
    # 3) script de login do guia (o que tem SUPABASE_URL) sai inteiro
    blocos = list(re.finditer(r'<script>(.*?)</script>', s, re.S))
    alvo = [b for b in blocos if 'SUPABASE_URL' in b.group(1)]
    assert len(alvo) == 1, 'bloco de login'
    b = alvo[0]
    s = s[:b.start()] + '<!-- login do guia removido: no Farol vale o login do portal -->' + s[b.end():]
    # 4) ponte do Farol no fim do body
    cfg = '<script>window.FAROL_CALC={regime:"%s",origem:"%s",commit:"%s"};</script>\n' % (regime, 'GUIA-' + regime, commit)
    i = s.rfind('</body>'); assert i > 0
    OFICIAL = (RAIZ / 'calc' / 'rtc_oficial.js').read_text(encoding='utf-8')   # gerado por montar_rtc_oficial.py
    s = s[:i] + cfg + '<script>\n' + OFICIAL + '\n</script>\n<script>\n' + PONTE + '\n</script>\n' + s[i:]
    s = s.replace('<title>', '<title>Farol Contábil · ', 1)
    pathlib.Path(saida).write_text(s, encoding='utf-8')
    print(saida, n0, '->', len(s))

if __name__ == '__main__':
    sn, lp, csn, clp = sys.argv[1:5]
    montar(sn, RAIZ / 'calc' / 'sn.html', 'SN', csn)
    montar(lp, RAIZ / 'calc' / 'lp.html', 'LP', clp)


def montar_motor(sn, lp, csn, clp):
    """calc/motor.js: as regras fiscais das calculadoras (cesta básica do Acre, cClassTrib/IBS-CBS e
    códigos de venda por regime) para a análise de produtos do portal usar exatamente as mesmas regras."""
    a = pathlib.Path(sn, 'index.html').read_text(encoding='utf-8')
    b = pathlib.Path(lp, 'index.html').read_text(encoding='utf-8')
    def trecho(s):
        return s[s.index('const ALIQ_CESTA_AC'):s.index('function row(k,v,small)')]
    assert trecho(a) == trecho(b), 'regras de cesta/IBS-CBS diferentes entre SN e LP'
    def regra(s, nome):
        m = re.search(r'function auditRegimeInfo\(rec, cesta\)\{.*?\n\}\n', s, re.S); assert m
        return m.group(0).replace('function auditRegimeInfo(', 'function ' + nome + '(')
    OFICIAL = (RAIZ / 'calc' / 'rtc_oficial.js').read_text(encoding='utf-8')
    js = ('// Gerado por ferramentas/montar_calc.py a partir de GUIA-SN ' + csn + ' e GUIA-LP ' + clp + ' e da tabela oficial da Receita (rtc_oficial.js). Não editar à mão.\n'
          + OFICIAL + '\n(function(){\n' + trecho(a) + '\n' + regra(a, 'regraSN') + '\n' + regra(b, 'regraLP') + '\n'
          '// cClassTrib: tabela oficial da Receita por NCM; a regra da calculadora só vale onde a Receita não lista NCM (medicamentos, absorventes, livros, combustíveis)\n'
          'var classificar = function (n, desc) { return window.farolClassificarRT(n, classifyRT, desc); };\n'
          'window.FAROL_MOTOR = { qualifyCestaAC: qualifyCestaAC, classifyRT: classificar, classifyRTCalculadora: classifyRT, regra: { SN: regraSN, LP: regraLP }, CESTA_AC: CESTA_AC, RT_RULES: RT_RULES, origem: "GUIA-SN ' + csn + ' / GUIA-LP ' + clp + ' + ' + 'Receita V0073" };\n})();\n')
    (RAIZ / 'calc' / 'motor.js').write_text(js, encoding='utf-8')
    print('motor.js', len(js))

if __name__ == '__main__':
    montar_motor(*sys.argv[1:5])
