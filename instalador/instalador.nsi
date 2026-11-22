Unicode true
!define VERSAO "2.0.1"
Name "Farol Contábil - Instalador do agente ${VERSAO}"
Caption "Farol Contábil - Instalador do agente (CPUSIS)"
OutFile "FarolContabil_Instalador_v${VERSAO}.exe"
RequestExecutionLevel admin
SilentInstall normal
ShowInstDetails nevershow
VIProductVersion "2.0.1.0"
VIAddVersionKey "ProductName" "Farol Contábil - Instalador do agente"
VIAddVersionKey "CompanyName" "CPUSIS"
VIAddVersionKey "FileDescription" "Instala o agente Farol Contábil 2.0 (LC Sistemas e Gestores) com envio retroativo"
VIAddVersionKey "FileVersion" "2.0.1.0"
VIAddVersionKey "ProductVersion" "${VERSAO}"
Page instfiles
Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\farol"
  File "arquivos\lcxml.ps1"
  File "arquivos\instalar.ps1"
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\farol\instalar.ps1" -Origem "$PLUGINSDIR\farol" -PastaExe "$EXEDIR"'
  SetOutPath "$TEMP"
SectionEnd
