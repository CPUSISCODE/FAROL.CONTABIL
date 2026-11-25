// Gerado por ferramentas/montar_calc.py a partir de GUIA-SN f4d24bb e GUIA-LP cbd0cd8. Não editar à mão.
(function(){
const ALIQ_CESTA_AC = 17;
const CESTA_AC = [
  {pref:'1006', nome:'Arroz', interna:false},
  {pref:'07133', nome:'Feijão', interna:false},
  {pref:'0201', nome:'Carne bovina', interna:true},
  {pref:'0202', nome:'Carne bovina congelada', interna:true},
  {pref:'0203', nome:'Carne suína', interna:true},
  {pref:'0204', nome:'Carne caprina/ovina', interna:true},
  {pref:'02061000', nome:'Miudezas bovinas', interna:true},
  {pref:'02062', nome:'Miudezas bovinas congeladas', interna:true},
  {pref:'02071100', nome:'Frango inteiro fresco', interna:true},
  {pref:'02071200', nome:'Frango inteiro congelado', interna:true},
  {pref:'040210', nome:'Leite em pó', interna:false},
  {pref:'04022110', nome:'Leite em pó integral', interna:false},
  {pref:'04022120', nome:'Leite em pó desnatado', interna:false},
  {pref:'19011010', nome:'Composto lácteo', interna:false},
  {pref:'19019090', nome:'Composto lácteo', interna:false},
  {pref:'1905', nome:'Pão, bolacha e biscoito', interna:true},
  {pref:'09012', nome:'Café', interna:true},
  {pref:'1701', nome:'Açúcar de cana comum', interna:false, exc:'exclui confeiteiro, orgânico, demerara, mascavo e light'},
  {pref:'11062000', nome:'Farinha de mandioca', interna:true},
  {pref:'15079011', nome:'Óleo de soja', interna:false},
  {pref:'04072100', nome:'Ovos de galinha', interna:true},
  {pref:'19021100', nome:'Macarrão espaguete', interna:false},
  {pref:'19021900', nome:'Macarrão espaguete', interna:false},
  {pref:'25010020', nome:'Sal de cozinha', interna:false},
  {pref:'0302', nome:'Peixes frescos', interna:true},
  {pref:'0303', nome:'Peixes congelados', interna:true},
  {pref:'07', nome:'Hortícolas in natura', interna:false},
  {pref:'08', nome:'Frutas in natura', interna:false},
  {pref:'0401', nome:'Lácteos', interna:true},
  {pref:'0402', nome:'Lácteos', interna:true},
  {pref:'0403', nome:'Lácteos', interna:true},
  {pref:'0404', nome:'Lácteos', interna:true},
  {pref:'0405', nome:'Lácteos', interna:true},
  {pref:'0406', nome:'Queijos', interna:true},
  {pref:'11010010', nome:'Farinha de trigo 25/50kg', interna:false},
  {pref:'19012000', nome:'Pré-mistura p/ pão francês', interna:false},
  {pref:'48202000', nome:'Caderno escolar', interna:false},
  {pref:'96081000', nome:'Caneta esferográfica', interna:false},
  {pref:'96091000', nome:'Lápis escolar', interna:false},
  {pref:'40169200', nome:'Borracha de apagar', interna:false},
  {pref:'30049045', nome:'Paracetamol', interna:false},
];
// mais específico vence; interna:false vence interna:true no mesmo comprimento
function qualifyCestaAC(ncm8, origemAC){
  let best=null, bestLen=0;
  for(const item of CESTA_AC){
    if(ncm8.startsWith(item.pref)){
      if(item.pref.length>bestLen || (item.pref.length===bestLen && !item.interna)){
        bestLen=item.pref.length; best=item;
      }
    }
  }
  if(!best) return null;
  if(best.interna && !origemAC) return {qualifica:false, item:best};
  return {qualifica:true, item:best};
}

// ============================================================
// Classificação oficial cClassTrib por NCM — venda a consumidor final
// Fonte: Tabela de Classificação Tributária IT 2025.002 (Portal Conformidade Fácil/SVRS)
// + Anexos I, VII, VIII, XIV, XV da LC 214/2025
// ============================================================
const RT_RULES = [
  // Cesta básica nacional (Anexo I — alíquota zero) → 200003
  {pref:['1006','0401','0402','190110','040510','151710','07133','0901','110620','1903','1101','1102','170114','170199','19021','100590','110412','0201','0202','0203','0204','0206','0207','0209','0210','0302','0303','0304','0406','2501','0903'],
   cst:'200', ct:'200003', label:'Cesta básica — alíquota zero (Anexo I, LC 214/2025)',
   caveat:'o Anexo I tem exceções pontuais dentro dessas posições (ex.: foie gras, salmão, ovas, queijos finos importados) — se o produto for uma dessas exceções, usar 200034 (red. 60%) ou 000001.'},
  // Hortícolas, frutas e ovos (Anexo XV — alíquota zero) → 200014
  {pref:['07','08','0407'],
   cst:'200', ct:'200014', label:'Hortícolas, frutas e ovos — alíquota zero (Anexo XV)',
   caveat:'vale para produtos in natura; se industrializado/processado, verificar enquadramento no Anexo VII (200034, red. 60%).'},
  // Alimentos gerais (Anexo VII — redução 60%) → 200034
  {pref:['1507','1508','1512','1514','1515','0403','0409','1103','1108','2002','2009','0306','1902'],
   cst:'200', ct:'200034', label:'Alimentos p/ consumo humano — redução de 60% (Anexo VII)',
   caveat:'conferir o NCM exato na lista do Anexo VII; itens fora dela vão para 000001.'},
  // Higiene pessoal e limpeza popular (Anexo VIII — redução 60%) → 200035
  {pref:['340111','330610','960321','481810','282890','340119'],
   cst:'200', ct:'200035', label:'Higiene pessoal e limpeza — redução de 60% (Anexo VIII)', caveat:null},
  // Absorventes e tampões (alíquota zero) → 200013 | fraldas (mesma posição 9619) → 200035
  {pref:['9619'],
   cst:'200', ct:'200013', label:'Absorventes/tampões higiênicos — alíquota zero',
   caveat:'a posição 9619 também abriga fraldas — para fraldas o código é 200035 (higiene, red. 60%), não 200013.'},
  // Medicamentos (registro Anvisa — red. 60% padrão; lista Anexo XIV = zero) → 200032 / 200009
  {pref:['3003','3004'],
   cst:'200', ct:'200032', label:'Medicamentos c/ registro Anvisa — redução de 60%',
   caveat:'se o princípio ativo constar na lista do Anexo XIV (LC 214/2025), o código passa a ser 200009 (alíquota zero); soros e vacinas usam 200053.'},
  // Dispositivos médicos (Anexo XII — red. 60%) → 200004
  {pref:['9018','9019','9021','300510','300590','300610'],
   cst:'200', ct:'200004', label:'Dispositivos médicos — redução de 60% (Anexo XII)',
   caveat:'confirmar presença do NCM no Anexo XII; fora dele, 000001.'},
  // Livros, jornais, periódicos (imunidade) → 410008
  {pref:['4901','4902','4903','4904','4905'],
   cst:'410', ct:'410008', label:'Livros, jornais e periódicos — imunidade constitucional', caveat:null},
  // Combustíveis (monofásico) → 620001
  {pref:['2710','2711','382600','382700','220710'],
   cst:'620', ct:'620001', label:'Combustíveis — tributação monofásica', caveat:null},
];

function classifyRT(ncm8){
  let best = null, bestLen = 0;
  for(const rule of RT_RULES){
    for(const p of rule.pref){
      if(ncm8.startsWith(p) && p.length > bestLen){
        bestLen = p.length;
        best = rule;
      }
    }
  }
  if(best) return {cst: best.cst, ct: best.ct, label: best.label, caveat: best.caveat};
  return {cst:'000', ct:'000001', label:'Tributação integral (padrão)', caveat:null};
}


function regraSN(rec, cesta){
  // Cesta básica AC (cadastro geral: só considera se produção NÃO é interna, senão depende da UF)
  const isCesta = !!(cesta && cesta.qualifica);
  const hasST = !!rec.seg;
  const mono = !!rec.mono;
  let cst, cfop, cst_pis;
  if(isCesta){
    cst = '400';   // CSOSN 400 (não tributada) — cesta básica AC
    cfop = '5102';
  } else if(hasST){
    cst = '500';   // CSOSN 500 (ICMS cobrado por ST)
    cfop = '5405';
  } else {
    cst = '102';   // CSOSN 102 (sem permissão de crédito)
    cfop = '5102';
  }
  cst_pis = mono ? '04' : '49'; // 04 = monofásico | 49 = outras operações de saída
  return {cst, cfop, cst_pis, cst_cofins: cst_pis};
}

function regraLP(rec, cesta){
  const isCesta = !!(cesta && cesta.qualifica);
  const hasST = !!rec.seg;
  const mono = !!rec.mono;
  let cst, cfop, cst_pis;
  if(isCesta){
    cst = '41';    // CST 41 (não tributada) — cesta básica AC
    cfop = '5102';
  } else if(hasST){
    cst = '60';    // CST 60 (ICMS cobrado por ST)
    cfop = '5405';
  } else {
    cst = '00';    // CST 00 (tributada integralmente)
    cfop = '5102';
  }
  // LP cumulativo por padrão: CST PIS/COFINS 01 (operação tributável cumulativa)
  // Monofásico: CST 04
  cst_pis = mono ? '04' : '01';
  return {cst, cfop, cst_pis, cst_cofins: cst_pis};
}

window.FAROL_MOTOR = { qualifyCestaAC: qualifyCestaAC, classifyRT: classifyRT, regra: { SN: regraSN, LP: regraLP }, CESTA_AC: CESTA_AC, RT_RULES: RT_RULES, origem: "GUIA-SN f4d24bb / GUIA-LP cbd0cd8" };
})();
