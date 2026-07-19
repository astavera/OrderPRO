[CmdletBinding(PositionalBinding = $false)]
param(
  [Parameter(Mandatory = $true)]
  [string]$ActorUserId,

  [Parameter(Mandatory = $true)]
  [string]$Reason,

  [Parameter(Mandatory = $true)]
  [string]$CertificationAuditEventId,

  [Parameter(Mandatory = $true)]
  [string]$EvidenceDigestSha256
)

$ErrorActionPreference = "Stop"

$uuid = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
$sha256 = '^[0-9a-f]{64}$'
$trimmedReason = $Reason.Trim()
$looksSensitive =
  $trimmedReason -match '(?i)\bBearer\s+' -or
  $trimmedReason -match '(?i)(client[_ -]?secret|access[_ -]?token|authorization\s*:)' -or
  $trimmedReason -match '[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}' -or
  $trimmedReason -match '(?:^|\s)[A-Za-z0-9_-]{32,}(?:\s|$)'

if (
  $ActorUserId -notmatch $uuid -or
  $CertificationAuditEventId -notmatch $uuid -or
  $EvidenceDigestSha256 -notmatch $sha256 -or
  $trimmedReason -ne $Reason -or
  $trimmedReason.Length -lt 10 -or
  $trimmedReason.Length -gt 500 -or
  $trimmedReason -match '[\x00-\x1f\x7f]' -or
  $looksSensitive
) {
  throw "Approval input is invalid. Provide only the actor, reason, certification audit ID, and evidence digest."
}

$forbiddenInheritedEnvironment = @(
  "AUTH0_CLIENT_SECRET",
  "AUTH0_M2M_CLIENT_SECRET",
  "ORDERPRO_M2M_CLIENT_SECRET",
  "AUTH0_ACCESS_TOKEN",
  "ORDERPRO_M2M_ACCESS_TOKEN",
  "AUTH0_MANAGEMENT_API_TOKEN",
  "AUTH0_MGMT_API_TOKEN",
  "AUTHORIZATION"
)
foreach ($name in $forbiddenInheritedEnvironment) {
  if (-not [String]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, "Process"))) {
    throw "Remove inherited Auth0 secrets or tokens before running approval."
  }
}

$workspace = Resolve-Path (Join-Path $PSScriptRoot "..")
$environmentFile = Join-Path $workspace ".env.local"
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$gitExecutable = (Get-Command git -ErrorAction Stop).Source
$requiredEnvironment = @(
  "DATABASE_URL",
  "ORDERPRO_M2M_AUTH_MODE",
  "ORDERPRO_RUNTIME_ENVIRONMENT",
  "ORDERPRO_LOCAL_DELIVERY_V4_API_ENABLED",
  "ORDERPRO_M2M_ISSUER",
  "ORDERPRO_M2M_AUDIENCE",
  "ORDERPRO_M2M_JWKS_URI",
  "ORDERPRO_M2M_ALLOWED_ALGORITHM"
)
$environmentValues = @{}

foreach ($line in [IO.File]::ReadLines($environmentFile)) {
  if ($line -match '^\s*$' -or $line -match '^\s*#') {
    continue
  }
  if ($line -notmatch '^\s*(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?<value>.*)\s*$') {
    continue
  }

  $name = $Matches.name
  if (
    $forbiddenInheritedEnvironment -contains $name -and
    -not [String]::IsNullOrWhiteSpace($Matches.value)
  ) {
    throw "Remove Auth0 secrets or tokens from the approval environment file."
  }
  if ($requiredEnvironment -notcontains $name) {
    continue
  }
  if ($environmentValues.ContainsKey($name)) {
    throw "The approval environment contains a duplicate required variable."
  }

  $value = $Matches.value.Trim()
  if ($value.Length -ge 2) {
    $first = $value.Substring(0, 1)
    $last = $value.Substring($value.Length - 1, 1)
    if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
      $value = $value.Substring(1, $value.Length - 2)
    }
  }
  $environmentValues[$name] = $value
}

foreach ($name in $requiredEnvironment) {
  if (-not $environmentValues.ContainsKey($name) -or [String]::IsNullOrWhiteSpace($environmentValues[$name])) {
    throw "The approval environment is incomplete."
  }
}
if (
  $environmentValues["ORDERPRO_M2M_AUTH_MODE"] -ne "DISABLED" -or
  $environmentValues["ORDERPRO_RUNTIME_ENVIRONMENT"] -ne "STAGING" -or
  $environmentValues["ORDERPRO_LOCAL_DELIVERY_V4_API_ENABLED"] -ne "false"
) {
  throw "Approval requires the M2M runtime and Local Delivery V4 API to remain locked."
}

$gitStatus = @(& $gitExecutable -C $workspace.Path status --porcelain=v1 --untracked-files=all 2>$null)
if ($LASTEXITCODE -ne 0 -or $gitStatus.Count -ne 0) {
  throw "Approval requires a clean, reviewed Git commit."
}
$sourceCommit = (& $gitExecutable -C $workspace.Path rev-parse --verify HEAD 2>$null).Trim()
$sourceTree = (& $gitExecutable -C $workspace.Path rev-parse --verify 'HEAD^{tree}' 2>$null).Trim()
if (
  $LASTEXITCODE -ne 0 -or
  $sourceCommit -notmatch '^[a-f0-9]{40,64}$' -or
  $sourceTree -notmatch '^[a-f0-9]{40,64}$'
) {
  throw "Approval could not attest the reviewed Git commit."
}

$processInfo = New-Object System.Diagnostics.ProcessStartInfo
$processInfo.FileName = $nodeExecutable
$processInfo.Arguments = "scripts/approve-auth0-m2m-staging.mjs"
$processInfo.WorkingDirectory = $workspace.Path
$processInfo.UseShellExecute = $false
$processInfo.CreateNoWindow = $true
$processInfo.RedirectStandardOutput = $true
$processInfo.RedirectStandardError = $true
$processInfo.EnvironmentVariables.Clear()

foreach ($name in @("SystemRoot", "TEMP", "TMP")) {
  $value = [Environment]::GetEnvironmentVariable($name, "Process")
  if (-not [String]::IsNullOrWhiteSpace($value)) {
    $processInfo.EnvironmentVariables[$name] = $value
  }
}
foreach ($name in $requiredEnvironment) {
  $processInfo.EnvironmentVariables[$name] = $environmentValues[$name]
}
$processInfo.EnvironmentVariables["NODE_ENV"] = "production"
$processInfo.EnvironmentVariables["ORDERPRO_APPROVAL_GIT_EXECUTABLE"] = $gitExecutable
$processInfo.EnvironmentVariables["ORDERPRO_APPROVAL_EXPECTED_COMMIT"] = $sourceCommit
$processInfo.EnvironmentVariables["ORDERPRO_APPROVAL_EXPECTED_TREE"] = $sourceTree
$processInfo.EnvironmentVariables["ORDERPRO_APPROVAL_ACTOR_USER_ID"] = $ActorUserId
$processInfo.EnvironmentVariables["ORDERPRO_APPROVAL_REASON"] = $trimmedReason
$processInfo.EnvironmentVariables["ORDERPRO_APPROVAL_CERTIFICATION_AUDIT_EVENT_ID"] = $CertificationAuditEventId
$processInfo.EnvironmentVariables["ORDERPRO_APPROVAL_EVIDENCE_DIGEST_SHA256"] = $EvidenceDigestSha256

$process = New-Object System.Diagnostics.Process
$process.StartInfo = $processInfo
$processStarted = $false
try {
  $null = $process.Start()
  $processStarted = $true
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(120000)) {
    try { $process.Kill() } catch { }
    throw "Approval timed out and was terminated."
  }

  $stdout = $stdoutTask.Result
  $stderr = $stderrTask.Result
  if (-not [String]::IsNullOrEmpty($stdout)) {
    [Console]::Out.Write($stdout)
  }
  if (-not [String]::IsNullOrEmpty($stderr)) {
    [Console]::Error.Write($stderr)
  }
  if ($process.ExitCode -ne 0) {
    exit $process.ExitCode
  }
}
finally {
  if ($processStarted -and -not $process.HasExited) {
    try { $process.Kill() } catch { }
  }
  $process.Dispose()
}
