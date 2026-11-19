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
