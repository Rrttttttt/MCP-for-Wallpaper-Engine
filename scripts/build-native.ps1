$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$localSdk = Join-Path $projectRoot '.we-mcp\tools\dotnet\dotnet.exe'
$dotnetCommand = if (Test-Path -LiteralPath $localSdk) { $localSdk } else { (Get-Command dotnet -ErrorAction Stop).Source }
$env:DOTNET_CLI_HOME = Join-Path $projectRoot '.we-mcp\tools\cli-home'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_ADD_GLOBAL_TOOLS_TO_PATH = '0'
$env:NUGET_PACKAGES = Join-Path $projectRoot '.we-mcp\tools\nuget'
& $dotnetCommand publish (Join-Path $projectRoot 'native\WeCapture\WeCapture.csproj') -c Release -r win-x64 --self-contained false -o (Join-Path $projectRoot 'native\WeCapture\bin\publish') "-p:RestoreConfigFile=$(Join-Path $projectRoot 'native\WeCapture\NuGet.Config')"
exit $LASTEXITCODE
