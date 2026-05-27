param()

$ErrorActionPreference = "Continue"

function Write-Info {
  param([string]$Message)
  Write-Host $Message
}

function Test-Command {
  param([string]$Name)
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Install-Gog {
  Write-Info "gog is not installed."
  Write-Info "Download the Windows ZIP from:"
  Write-Info "  https://github.com/openclaw/gogcli/releases"
  Write-Info "Extract gog.exe and put that directory on PATH, then rerun this script."
  return 10
}

if (-not (Test-Command "gog")) {
  $installCode = Install-Gog
  exit $installCode
}

$version = (& gog --version 2>&1 | Select-Object -First 1)
Write-Info "Detected: $version"

& gog auth doctor --check --no-input *> $null
if ($LASTEXITCODE -eq 0) {
  Write-Info "gog auth doctor succeeded."
  exit 0
}

Write-Info "A Desktop OAuth client JSON is required."
Write-Info "Create one in Google Cloud Console, enable the APIs you need, then download the JSON."
Write-Info "Common services for a local agent: gmail,calendar,drive,docs,sheets,contacts"
Write-Info "Never commit OAuth client JSON files or tokens."

$clientJson = Read-Host "Path to Desktop OAuth client JSON"
if (-not $clientJson -or -not (Test-Path $clientJson)) {
  Write-Info "Credential file not found: $clientJson"
  exit 20
}

$account = Read-Host "Google account email to add"
if (-not $account) {
  Write-Info "Account email is required."
  exit 21
}

$services = Read-Host "Services [gmail,calendar,drive,docs,sheets,contacts]"
if (-not $services) {
  $services = "gmail,calendar,drive,docs,sheets,contacts"
}

Write-Info "Storing OAuth client in gog..."
& gog auth credentials $clientJson
if ($LASTEXITCODE -ne 0) {
  exit 22
}

Write-Info "Adding account. Browser consent may open."
& gog auth add $account --services $services
if ($LASTEXITCODE -ne 0) {
  exit 23
}

Write-Info "Verifying auth..."
& gog auth doctor --check --no-input
if ($LASTEXITCODE -ne 0) {
  exit 24
}

Write-Info "gog setup is healthy."
