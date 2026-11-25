#!/usr/bin/env python3
"""calc/rtc_oficial.js: a classificação de IBS/CBS (cClassTrib) por NCM tirada do código-fonte OFICIAL da
Calculadora de Tributos da Receita Federal (github.com/ReceitaFederal/calculadora-rtc-regime-regular, MIT).
Monta o banco SQLite da Receita a partir das migrações flyway e exporta, para as classificações de IBS/CBS
vigentes em 01/01/2027 que dependem de NCM, os prefixos de NCM aplicáveis e as exceções.
Uso: python3 ferramentas/montar_rtc_oficial.py <pasta do repositório da Receita> <commit>"""
import sqlite3, glob, re, json, sys, pathlib, tempfile, os
REPO, COMMIT = sys.argv[1], sys.argv[2]
RAIZ = pathlib.Path(__file__).resolve().parent.parent
D = '2027-01-01'
db = os.path.join(tempfile.mkdtemp(), 'rtc.db')
c = sqlite3.connect(db)
d = REPO + '/flyway/sql/'
arqs = [d + 'criacao/beforeMigrate.sql', d + 'criacao/B0001__sistema_tributario_completo.sql'] + \
       sorted(glob.glob(d + 'manutencao/V*.sql'), key=lambda f: int(re.search(r'V(\d+)', f).group(1))) + [d + 'criacao/afterMigrate.sql']
for f in arqs:   # as chaves estrangeiras ficam desligadas durante a carga (a ordem das migrações da Receita depende disso)
    c.executescript('PRAGMA foreign_keys = OFF;' + open(f, encoding='utf-8').read().replace('PRAGMA foreign_keys = ON;', 'PRAGMA foreign_keys = OFF;'))
assert not c.execute('PRAGMA foreign_key_check').fetchall(), 'chaves estrangeiras quebradas no banco montado'
versao = re.search(r'V(\d+)__', arqs[-2]).group(1)
viv = lambda a, b: "(%s <= '%s' and (%s is null or %s >= '%s'))" % (a, D, b, b, D)
classes = {}
for cid, cd, desc in c.execute(f"""select distinct t.CLTR_ID, t.CLTR_CD, t.CLTR_DESCRICAO from CLASSIFICACAO_TRIBUTARIA t
      join TRIBUTO_SITUACAO_TRIBUTARIA s on s.TRST_SITR_ID = t.CLTR_SITR_ID and s.TRST_TBTO_ID = 2
      where {viv('t.CLTR_INICIO_VIGENCIA', 't.CLTR_FIM_VIGENCIA')}""").fetchall():
    red = c.execute(f"select PERE_VALOR from PERCENTUAL_REDUCAO where PERE_CLTR_ID=? and PERE_TBTO_ID=2 and {viv('PERE_INICIO_VIGENCIA','PERE_FIM_VIGENCIA')}", (cid,)).fetchone()
    classes[cid] = {'c': cd, 'd': desc, 'r': float(red[0]) if red else 0}
regras = []
for nid, ncm, cid in c.execute(f"select NCMA_ID, NCMA_NCM_CD, NCMA_CLTR_ID from NCM_APLICAVEL where {viv('NCMA_INICIO_VIGENCIA','NCMA_FIM_VIGENCIA')} order by NCMA_NCM_CD, NCMA_CLTR_ID, NCMA_ID").fetchall():
    if cid not in classes: continue
    exc = sorted({r[0] for r in c.execute(f"select ENCM_NCM_CD from EXCECAO_NCM_APLICAVEL where ENCM_NCMA_ID=? and {viv('ENCM_INICIO_VIGENCIA','ENCM_FIM_VIGENCIA')}", (nid,))})
    regras.append([ncm, classes[cid]['c']] + ([exc] if exc else []))
usadas = {r[1] for r in regras} | {'200009', '200013', '200032', '410008', '620001', '000001'}
cls = {v['c']: {'d': v['d'], 'r': v['r']} for v in classes.values() if v['c'] in usadas}
dados = {'fonte': 'Receita Federal · calculadora-rtc-regime-regular ' + COMMIT + ' (base V' + versao + ')', 'vigencia': D, 'classes': cls, 'regras': regras}
js = '''// Gerado por ferramentas/montar_rtc_oficial.py a partir do código-fonte oficial da Calculadora de Tributos da
// Receita Federal (github.com/ReceitaFederal/calculadora-rtc-regime-regular). Não editar à mão.
(function () {
  var O = ''' + json.dumps(dados, ensure_ascii=False, separators=(',', ':')) + ''';
  // venda a consumidor no comércio: ordem de preferência quando o NCM cabe em mais de uma classificação.
  // Ficam de fora as que dependem de quem compra (governo, entidades) ou da operação (diferimento entre produtores).
  var ORDEM = ['200003', '200014', '200004', '200007', '200035', '200034', '200030', '200031', '200033', '200038', '200039'];
  var AVISO = {
    '200038': 'insumo agropecuário/aquícola (Anexo IX): a redução vale para o produto registrado no MAPA e usado na produção; na venda comum ao consumidor confirme se o item se enquadra',
    '200034': 'confira se o produto é exatamente o descrito no Anexo VII',
    '200030': 'dispositivo médico (Anexo IV): exige registro na Anvisa',
    '200004': 'dispositivo médico do Anexo XII: exige registro na Anvisa',
    '200033': 'composição para nutrição enteral/parenteral (Anexo VI)',
    '200007': 'dispositivo de acessibilidade (Anexo XIII)', '200031': 'dispositivo de acessibilidade (Anexo V)'
  };
  // classificações oficiais que não têm lista de NCM na Receita (dependem do registro do produto): vale a regra da calculadora
  var SEM_LISTA = { '200009': 1, '200013': 1, '200032': 1, '410008': 1, '620001': 1 };
  function aplicaveis(ncm) {
    var r = [];
    for (var i = 0; i < O.regras.length; i++) {
      var g = O.regras[i];
      if (ncm.indexOf(g[0]) === 0 && !(g[2] && g[2].some(function (x) { return ncm.indexOf(x) === 0; })) && r.indexOf(g[1]) < 0) r.push(g[1]);
    }
    return r;
  }
  window.farolClassificarRT = function (ncm8, regraCalculadora, descricao) {
    ncm8 = String(ncm8 || '').replace(/\\D/g, '');
    var ap = aplicaveis(ncm8), venda = ORDEM.filter(function (c) { return ap.indexOf(c) >= 0; });
    var calc = regraCalculadora ? regraCalculadora(ncm8) : null, ct, caveat = null;
    var absorvente = /absorv|tamp[aã]o|coletor menstrual/i.test(String(descricao || ''));
    if (calc && SEM_LISTA[calc.ct] && calc.ct !== '200013') {   // medicamento, livro, combustível: depende do registro do produto, a Receita não lista NCM
      ct = calc.ct; caveat = calc.caveat; venda = [ct].concat(venda.filter(function (c) { return c !== ct; }));
    } else if (ncm8.indexOf('9619') === 0 && absorvente) { ct = '200013'; venda = [ct].concat(venda); }
    else if (venda.length) ct = venda[0];
    else ct = '000001';
    var cl = O.classes[ct] || {}, outras = venda.slice(1);
    if (ncm8.indexOf('9619') === 0 && !absorvente) caveat = 'absorventes e tampões higiênicos usam 200013 (alíquota zero); fraldas e outros itens da posição 9619, 200035';
    if (AVISO[ct]) caveat = AVISO[ct] + (caveat ? '; ' + caveat : '');
    if (outras.length) caveat = (caveat ? caveat + '; ' : '') + 'o NCM também cabe em ' + outras.map(function (c) { return c + ' (' + (O.classes[c] || {}).d + ')'; }).join(', ');
    return { cst: ct.slice(0, 3), ct: ct, label: ct === '000001' ? 'Tributação integral (padrão)' : cl.d + (cl.r ? ' — redução de ' + cl.r + '%' : ''), caveat: caveat,
      reducao: cl.r || 0, alternativas: outras, oficial: !(calc && SEM_LISTA[ct]), fonte: O.fonte,
      calculadora: calc ? calc.ct : null };
  };
  window.FAROL_RTC_OFICIAL = { fonte: O.fonte, classes: O.classes, aplicaveis: aplicaveis };
})();
'''
(RAIZ / 'calc' / 'rtc_oficial.js').write_text(js, encoding='utf-8')
(RAIZ / 'dados').mkdir(exist_ok=True)
dados['base'] = 'V' + versao; dados['commit'] = COMMIT
(RAIZ / 'dados' / 'rtc_oficial.json').write_text(json.dumps(dados, ensure_ascii=False, indent=0, sort_keys=True), encoding='utf-8')
print('rtc_oficial.js', len(js), 'regras', len(regras), 'classes', len(cls), dados['fonte'])
