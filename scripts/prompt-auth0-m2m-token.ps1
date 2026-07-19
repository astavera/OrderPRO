$ErrorActionPreference = "Stop"

if ($args.Count -ne 0) {
  Write-Error "This command accepts no arguments. Never pass a token on the command line."
  exit 1
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
    throw "Remove inherited Auth0 secrets or tokens before running certification."
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
  if ($requiredEnvironment -notcontains $name) {
    continue
  }
  if ($environmentValues.ContainsKey($name)) {
    throw "The certification environment contains a duplicate required variable."
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
    throw "The certification environment is incomplete."
  }
}

$gitStatus = @(& $gitExecutable -C $workspace.Path status --porcelain=v1 --untracked-files=all 2>$null)
if ($LASTEXITCODE -ne 0 -or $gitStatus.Count -ne 0) {
  throw "Certification requires a clean, reviewed Git commit before reading a token."
}
$sourceCommit = (& $gitExecutable -C $workspace.Path rev-parse --verify HEAD 2>$null).Trim()
$sourceTree = (& $gitExecutable -C $workspace.Path rev-parse --verify 'HEAD^{tree}' 2>$null).Trim()
if (
  $LASTEXITCODE -ne 0 -or
  $sourceCommit -notmatch '^[a-f0-9]{40,64}$' -or
  $sourceTree -notmatch '^[a-f0-9]{40,64}$'
) {
  throw "Certification could not attest the reviewed Git commit."
}

$processInfo = New-Object System.Diagnostics.ProcessStartInfo
$processInfo.FileName = $nodeExecutable
$processInfo.Arguments = "--conditions=react-server --import=tsx scripts/certify-auth0-m2m-token.ts"
$processInfo.WorkingDirectory = $workspace.Path
$processInfo.UseShellExecute = $false
$processInfo.CreateNoWindow = $true
$processInfo.RedirectStandardInput = $true
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
$processInfo.EnvironmentVariables["ORDERPRO_CERTIFICATION_GIT_EXECUTABLE"] = $gitExecutable
$processInfo.EnvironmentVariables["ORDERPRO_CERTIFICATION_EXPECTED_COMMIT"] = $sourceCommit
$processInfo.EnvironmentVariables["ORDERPRO_CERTIFICATION_EXPECTED_TREE"] = $sourceTree

$secureToken = $null
$tokenPointer = [IntPtr]::Zero
$tokenCharacters = $null
$tokenBytes = $null
$process = $null
$processStarted = $false

try {
  Write-Host "Use only the short-lived token from Auth0 Test. If Windows clipboard history is enabled, remove the token there after this command."
  $secureToken = Read-Host "Paste the Auth0 access token (input is hidden)" -AsSecureString

  $postPromptGitStatus = @(& $gitExecutable -C $workspace.Path status --porcelain=v1 --untracked-files=all 2>$null)
  $postPromptStatusExitCode = $LASTEXITCODE
  $postPromptCommit = [string](& $gitExecutable -C $workspace.Path rev-parse --verify HEAD 2>$null)
  $postPromptCommitExitCode = $LASTEXITCODE
  $postPromptTree = [string](& $gitExecutable -C $workspace.Path rev-parse --verify 'HEAD^{tree}' 2>$null)
  $postPromptTreeExitCode = $LASTEXITCODE
  if (
    $postPromptStatusExitCode -ne 0 -or
    $postPromptCommitExitCode -ne 0 -or
    $postPromptTreeExitCode -ne 0 -or
    $postPromptGitStatus.Count -ne 0 -or
    $postPromptCommit.Trim() -ne $sourceCommit -or
    $postPromptTree.Trim() -ne $sourceTree
  ) {
    throw "The reviewed Git commit changed while waiting for the token."
  }

  $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  $tokenCharacterCount = [Runtime.InteropServices.Marshal]::ReadInt32($tokenPointer, -4) / 2
  $tokenCharacters = New-Object char[] $tokenCharacterCount
  [Runtime.InteropServices.Marshal]::Copy(
    $tokenPointer,
    $tokenCharacters,
    0,
    $tokenCharacterCount
  )
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
  $tokenPointer = [IntPtr]::Zero
  $tokenBytes = [Text.Encoding]::UTF8.GetBytes([char[]]$tokenCharacters)

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $processInfo
  $null = $process.Start()
  $processStarted = $true
  $deadline = [Diagnostics.Stopwatch]::StartNew()
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $writeTask = $process.StandardInput.BaseStream.WriteAsync(
    $tokenBytes,
    0,
    $tokenBytes.Length
  )
  if (-not $writeTask.Wait(5000)) {
    throw "Certification input timed out and was terminated."
  }
  $process.StandardInput.Close()
  [Array]::Clear($tokenBytes, 0, $tokenBytes.Length)
  [Array]::Clear($tokenCharacters, 0, $tokenCharacters.Length)
  $remainingMilliseconds = 120000 - [int]$deadline.ElapsedMilliseconds
  if ($remainingMilliseconds -le 0 -or -not $process.WaitForExit($remainingMilliseconds)) {
    throw "Certification timed out and was terminated."
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
  if ($process -ne $null) {
    if ($processStarted) {
      try {
        if (-not $process.HasExited) {
          $process.Kill()
          $process.WaitForExit()
        }
      }
      catch {
        # Best effort after a timeout; the certification child has no expected subprocesses.
      }
    }
    $process.Dispose()
  }
  if ($tokenPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
  }
  if ($tokenBytes -ne $null) {
    [Array]::Clear($tokenBytes, 0, $tokenBytes.Length)
  }
  if ($tokenCharacters -ne $null) {
    [Array]::Clear($tokenCharacters, 0, $tokenCharacters.Length)
  }
  $tokenBytes = $null
  $tokenCharacters = $null
  if ($secureToken -ne $null) {
    $secureToken.Dispose()
  }
  try {
    Set-Clipboard -Value ""
  }
  catch {
    # Current clipboard cleanup is best-effort. Windows history is user-managed.
  }
}
