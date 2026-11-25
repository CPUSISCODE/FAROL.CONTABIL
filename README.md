# Farol Contábil — LC XML (CPUSIS)

Portal dos escritórios de contabilidade e automação de envio dos XML fiscais dos clientes LC Sistemas.

**Portal:** https://cpusiscode.github.io/farol.contabil/
(o endereço antigo do Google `…/exec` continua funcionando)

## Como funciona

| Pasta / arquivo | O que é |
|---|---|
| `index.html` | Portal (o mesmo `receptor/Portal.html`), servido pelo GitHub Pages: abre na hora e conversa com o receptor |
| `receptor/Carregador.gs` | **Único código que fica no Apps Script.** Não muda: baixa o receptor daqui e executa |
| `receptor/Codigo.gs` | Receptor de verdade (envios dos agentes + API do portal) |
| `receptor/appsscript.json` | Manifesto do Apps Script (permissões e App da Web) |
| `agente/lcxml.ps1` | Agente instalado nos servidores dos clientes (lê o MySQL do LC **só para leitura**) |
| `agente/lcxml_piloto.ps1` | Versão do agente em teste: só as máquinas listadas em `agentePiloto.maquinas` do `versao.json` recebem |
| `versao.json` | Versões publicadas. **Mudar este arquivo = liberar a atualização** |

## Atualização automática

A cada 15 minutos o receptor (Apps Script) lê `versao.json` deste repositório. Se houver versão nova:

1. **receptor** — o carregador baixa `receptor/Codigo.gs`, testa, guarda cópia no Drive (`_PORTAL_DADOS/receptor`) e passa a usar na hora (mesma URL `/exec`, sem nova implantação). Se o GitHub cair, roda a última cópia boa do Drive;
2. **portal** — troca `_PORTAL_DADOS/portal/Portal.html` no Drive (o GitHub Pages já se atualiza sozinho);
3. **agente** — troca `_PORTAL_DADOS/agente/lcxml.ps1` no Drive; cada agente baixa na próxima execução.

Tudo fica registrado na aba **Atualizações** da planilha "LC XML - Painel de envios".

## Segurança

- Nenhuma senha fica neste repositório. As senhas do receptor (`SENHA`, `SENHA_BACKUP`) ficam nas
  *Propriedades do script* do Apps Script.
- O portal só mostra dados depois do login de cada escritório; cada login só vê as próprias contabilidades.
- Os instaladores (.exe) **não** ficam aqui, porque levam a senha de conexão.

## Acessos, perfis e permissões (desde 25/11/2026)

Os logins ficam **no banco** (tabela `usuarios`) e são administrados no portal, menu **Acessos**.
A aba Usuários da planilha não vale mais (`portal_config.usuarios_no_banco`); o login antigo pelo Apps Script foi desligado.

| Perfil | Vê | Pode |
|---|---|---|
| Administrador | tudo | criar qualquer login, configurações, servidores |
| Equipe CPUSIS | todas as contabilidades | operar BPO, servidores, regimes |
| Gestor da contabilidade | as contabilidades dele | criar logins de contador e de cliente das contabilidades dele |
| Contador | as contabilidades marcadas | os módulos marcados |
| Cliente | só a própria empresa | resumo, XML, conferência, análise de produtos, calculadora, financeiro (BPO) |

Cada login pode ter módulos a menos do que o perfil permite. A API (`supabase/functions/farol/main.ts`)
confere perfil, módulo e empresa a cada pedido; o receptor e a função `rtc` também conferem a empresa do cliente.

Segurança: senhas em PBKDF2-SHA256 (150 mil rodadas, migração automática das antigas no primeiro login);
bloqueio por login (8 erros/15 min) e por IP (30 erros/15 min); sessão com 4 h de inatividade e 12 h no máximo,
derrubada ao trocar senha/perfil; saída automática da tela após 1 h parada; troca de senha obrigatória quando marcada;
registro de acessos com IP; CSP no portal publicado (`ferramentas/publicar_portal.py` gera o `index.html`).

## Funções do Supabase

`farol` e `rtc` são publicadas com um `index.ts` de uma linha que importa o `main.ts` deste repositório
**de um commit fixo**: mudar o código aqui não muda nada em produção até publicar o `index.ts` com o commit novo.

## Calculadoras (GUIA-SN e GUIA-LP)

`calc/sn.html` e `calc/lp.html` são montados por `ferramentas/montar_calc.py` a partir dos repositórios
GUIA-SN e GUIA-LP (as regras fiscais não são mexidas): o login vira o do portal, a base de NCM vem do banco do
Farol (`ncm_base`), o XML pode vir das notas do cliente e a impressão sai com a logo da CPUSIS.
`calc/motor.js` traz as mesmas regras para a **Análise fiscal dos produtos** do portal.
Para atualizar depois de mudar um guia: `python3 ferramentas/montar_calc.py <GUIA-SN> <GUIA-LP> <commit-sn> <commit-lp>`.
