# Farol Contábil — LC XML (CPUSIS)

Portal dos escritórios de contabilidade e automação de envio dos XML fiscais dos clientes LC Sistemas.

**Portal:** https://cpusiscode.github.io/farol.contabil/
(o endereço antigo do Google `…/exec` continua funcionando)

## Como funciona

| Pasta / arquivo | O que é |
|---|---|
| `index.html` | Portal (o mesmo `receptor/Portal.html`), servido pelo GitHub Pages: abre na hora e conversa com o receptor |
| `receptor/` | Código do Google Apps Script (receptor + API do portal) e o manifesto `appsscript.json` |
| `agente/lcxml.ps1` | Agente instalado nos servidores dos clientes (lê o MySQL do LC **só para leitura**) |
| `versao.json` | Versões publicadas. **Mudar este arquivo = liberar a atualização** |

## Atualização automática

A cada 15 minutos o receptor (Apps Script) lê `versao.json` deste repositório. Se houver versão nova:

1. **receptor** — troca o próprio código, cria uma versão nova e atualiza a implantação (mesma URL `/exec`);
2. **portal** — troca `_PORTAL_DADOS/portal/Portal.html` no Drive (o GitHub Pages já se atualiza sozinho);
3. **agente** — troca `_PORTAL_DADOS/agente/lcxml.ps1` no Drive; cada agente baixa na próxima execução.

Tudo fica registrado na aba **Atualizações** da planilha "LC XML - Painel de envios".

## Segurança

- Nenhuma senha fica neste repositório. As senhas do receptor (`SENHA`, `SENHA_BACKUP`) ficam nas
  *Propriedades do script* do Apps Script.
- O portal só mostra dados depois do login de cada escritório; cada login só vê as próprias contabilidades.
- Os instaladores (.exe) **não** ficam aqui, porque levam a senha de conexão.
