Unicode true
!define VERSAO "1.0"
Name "Farol Contábil - Robô do Avante ${VERSAO}"
Caption "Farol Contábil - Robô do Avante Web (CPUSIS)"
OutFile "FarolContabil_RoboAvante_v${VERSAO}.exe"
RequestExecutionLevel admin
SilentInstall normal
ShowInstDetails show
InstallDir "C:\FarolRobo"
VIProductVersion "1.0.0.0"
VIAddVersionKey "ProductName" "Farol Contábil - Robô do Avante Web"
VIAddVersionKey "CompanyName" "CPUSIS"
VIAddVersionKey "FileDescription" "Baixa XML e relatórios financeiros do Avante Web para o Farol Contábil"
VIAddVersionKey "FileVersion" "1.0.0.0"
VIAddVersionKey "ProductVersion" "${VERSAO}"
Page instfiles
Section
  ; só os arquivos do programa: config.json, segredo.bin, perfil do Edge, estado e logs de uma instalação anterior ficam como estão
  SetOutPath "$INSTDIR"
  File "arquivos\robo.js"
  File "arquivos\rodar.ps1"
  File "arquivos\configurar.ps1"
  File "arquivos\instalar.ps1"
  SetOutPath "$INSTDIR\node"
  File "arquivos\node\node.exe"
  SetOutPath "$INSTDIR\node_modules"
  File /r "arquivos\node_modules\*.*"
  SetOutPath "$INSTDIR\processador"
  File "arquivos\processador\lcxml.ps1"
  SetOutPath "$INSTDIR"
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\configurar.ps1"'
SectionEnd
