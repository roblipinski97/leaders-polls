# Refresh the polling dashboard: new polls, elections held, rollover, rebuild.
# Run from this folder in PowerShell:   .\update.ps1
# (If scripts are blocked: powershell -ExecutionPolicy Bypass -File .\update.ps1)
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
if (-not $env:POLLS_USER_AGENT) {
    # Wikimedia asks API users to identify themselves; put your own contact here.
    $env:POLLS_USER_AGENT = "EuropePollsDashboard/1.0 (personal research dashboard)"
}
python -m polls update
if ($LASTEXITCODE -ne 0) { throw "update failed" }
Write-Host ""
Write-Host "Done. To look at it:  python -m http.server 8000 --directory site   then open http://localhost:8000"
