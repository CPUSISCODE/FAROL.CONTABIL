Unicode true
!define VERSAO "2.5"
Name "Farol Contábil - Atualizador do agente ${VERSAO}"
Caption "Farol Contábil - Atualizador do agente (CPUSIS)"
OutFile "FarolContabil_Atualizador_v${VERSAO}.exe"
RequestExecutionLevel admin
SilentInstall normal
ShowInstDetails nevershow
VIProductVersion "2.2.0.0"
VIAddVersionKey "ProductName" "Farol Contábil - Atualizador do agente"
VIAddVersionKey "CompanyName" "CPUSIS"
VIAddVersionKey "FileDescription" "Atualiza o agente Farol Contábil (LC XML) para a versão ${VERSAO}"
VIAddVersionKey "FileVersion" "2.2.0.0"
VIAddVersionKey "ProductVersion" "${VERSAO}"
Page instfiles
Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\farol"
  File "arquivos\lcxml.ps1"
  File "arquivos\atualizar.ps1"
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\farol\atualizar.ps1" -Novo "$PLUGINSDIR\farol\lcxml.ps1"'
  SetOutPath "$TEMP"
SectionEnd
