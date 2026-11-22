# Robô do Avante Web (Farol Contábil)

Baixa, pelo Painel do Parceiro do Avante, os XML (Fiscal → Gestão de Documentos) e os relatórios financeiros
(Lançamentos Financeiros e Contas a Receber/Pagar, em Excel) de cada cliente e manda para o Farol pelo receptor.

- `robo.js` — o robô (Node + playwright-core, usando o Edge do Windows). Só consulta e baixa.
- `configurar.ps1` — configuração (login do Avante criptografado com DPAPI da máquina, empresas, agendamento).
- `rodar.ps1` — usado pela tarefa agendada.
- `robo.nsi` — instalador (o node.exe e o playwright-core entram no pacote na hora do build; senhas nunca vão no .exe).

Os ZIP vão para a pasta do mês do cliente; o processador de XML enviados à mão (lcxml.ps1 -Manuais) monta o resumo do portal.
Os Excel do financeiro vão para _PORTAL_DADOS/CONTABILIDADE/CLIENTE[/SUBPASTA].
