<#
.SYNOPSIS
  Install a released atomic-agent CLI (Node SEA) from GitHub Releases on Windows.

.DESCRIPTION
  Windows counterpart of scripts/install.sh. Downloads the release zip, verifies
  its SHA256 checksum, extracts the CLI plus support assets (grammars/, vendor/,
  node_modules/, starter-skills/, assets/) into an install directory, and adds
  that directory to the user PATH.

.EXAMPLE
  irm https://atomicagent.io/install.ps1 | iex

.NOTES
  Environment overrides (mirrors install.sh):
    ATOMIC_AGENT_REPO         owner/atomic-agent   (default: AtomicBot-ai/atomic-agent)
    ATOMIC_AGENT_VERSION      v0.1.0               (optional: pin a tag; default: latest)
    ATOMIC_AGENT_INSTALL_DIR  path                 (default: %LOCALAPPDATA%\atomic-agent)
    ATOMIC_AGENT_NO_PATH      1                    (optional: skip user PATH update)
#>

$ErrorActionPreference = "Stop"

# Invoke-WebRequest renders a progress bar per chunk. On a 40+ MB release zip
# that costs more wall time than the transfer itself, and when the in-app
# updater captures stdout it can stall outright.
$ProgressPreference = "SilentlyContinue"

# PowerShell 5.1 defaults to TLS 1.0/1.1; GitHub requires TLS 1.2+.
try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
  # Older frameworks may not expose Tls12 by name — best effort.
}

$RepoDefault = "AtomicBot-ai/atomic-agent"
$Repo = if ($env:ATOMIC_AGENT_REPO) { $env:ATOMIC_AGENT_REPO } else { $RepoDefault }
$Version = $env:ATOMIC_AGENT_VERSION
$InstallDir = if ($env:ATOMIC_AGENT_INSTALL_DIR) {
  $env:ATOMIC_AGENT_INSTALL_DIR
} else {
  Join-Path $env:LOCALAPPDATA "atomic-agent"
}

function Write-Info($msg) { Write-Host $msg }

# Throws rather than exiting: the install transaction below has to observe the
# failure so it can roll back before the process dies. The top-level catch
# turns the exception into a single readable line and exits 1.
function Fail($msg) { throw $msg }

# Invoke-WebRequest's exception names the status code but not the URL, so a bare
# "404 (Not Found)" during self-update does not say whether the tag, the repo or
# the asset name was wrong. Attribute it.
function Get-RemoteFile($url, $dest) {
  try {
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -ErrorAction Stop
  } catch {
    Fail "download failed: $url`n  $($_.Exception.Message)"
  }
}

# Suffix for files moved aside during a self-update over a running install.
$script:BackupStamp = Get-Date -Format "yyyyMMddHHmmss"

# Best-effort removal of leftover *.old-* files from a previous self-update.
# A file still mapped by a live process stays locked; skip it and let a
# later run clean it up.
function Remove-StaleBackups($dir) {
  Get-ChildItem -Path $dir -Recurse -File -Filter "*.old-*" -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop
    } catch {
      Write-Info "note: could not remove stale $($_.Name) (in use); it will be cleaned on a later update"
    }
  }
}

# Undo a partially-applied transaction: drop whatever we already wrote and put
# every displaced original back where it was. Walks the journal in reverse so
# the most recently touched files are restored first.
#
# Best-effort per entry — one unrecoverable file must not stop the rest from
# being restored, so the install ends up as close to its pre-update state as
# the filesystem allows. Anything left behind keeps its .old-<stamp> name and
# is reported, never silently dropped.
function Undo-TreeTransaction($journal) {
  # Nothing was touched yet (e.g. the staged tree could not be enumerated), so
  # announcing a rollback would only be misleading.
  if ($journal.Count -eq 0) { return }
  Write-Info "rolling back partial install ..."
  $stranded = @()
  for ($i = $journal.Count - 1; $i -ge 0; $i--) {
    $entry = $journal[$i]
    try {
      # The fresh copy is never mapped by a live process (the original was
      # displaced before it was written), so this delete always has a path.
      if (Test-Path -LiteralPath $entry.Target) {
        Remove-Item -LiteralPath $entry.Target -Force -ErrorAction Stop
      }
      if ($entry.Backup) {
        Move-Item -LiteralPath $entry.Backup -Destination $entry.Target -Force -ErrorAction Stop
      }
    } catch {
      $stranded += $entry.Target
    }
  }
  if ($stranded.Count -gt 0) {
    Write-Info "warning: could not restore $($stranded.Count) file(s):"
    foreach ($path in $stranded) { Write-Info "  $path" }
    Write-Info "close atomic-agent and re-run the installer to repair the install"
  }
}

# Drop the displaced originals a committed transaction no longer needs. The
# ones the live process still maps (its own atomic-agent.exe, the loaded
# better_sqlite3.node) cannot be deleted while it runs — they keep their
# .old-<stamp> name and Remove-StaleBackups collects them on a later update.
function Remove-TransactionBackups($journal) {
  foreach ($entry in $journal) {
    if (-not $entry.Backup) { continue }
    try {
      Remove-Item -LiteralPath $entry.Backup -Force -ErrorAction Stop
    } catch {
      Write-Info "note: $(Split-Path -Leaf $entry.Backup) is still in use; it will be cleaned on a later update"
    }
  }
}

# Whether two files already hold the same bytes. Length is compared first so
# the hash only runs on genuine candidates.
function Test-SameFile($left, $right) {
  if ((Get-Item -LiteralPath $left).Length -ne (Get-Item -LiteralPath $right).Length) {
    return $false
  }
  $leftHash = (Get-FileHash -LiteralPath $left -Algorithm SHA256).Hash
  $rightHash = (Get-FileHash -LiteralPath $right -Algorithm SHA256).Hash
  return $leftHash -eq $rightHash
}

# Apply a staged tree onto the install dir as a single all-or-nothing
# transaction: either every file is the new version, or the install is left as
# it was before the run.
#
# Windows forbids overwriting a file a live process holds open but allows
# RENAMING it, so every pre-existing target is displaced to <name>.old-<stamp>
# BEFORE the fresh copy is written. That ordering is the whole point — nothing
# is ever overwritten in place, so every step stays reversible and a failure
# halfway through can be undone. This is what makes in-app self-update work on
# Windows; the live process keeps executing from the displaced file until the
# user relaunches.
#
# Directory-level swap (what install.sh does via replace_dir) is deliberately
# not used here: Windows refuses to rename a directory that contains a loaded
# module, and node_modules/ holds better_sqlite3.node while the agent runs. So
# the granularity has to be per-file.
function Copy-TreeTransactional($src, $dst) {
  $journal = New-Object System.Collections.ArrayList
  $unchanged = 0
  try {
    foreach ($item in Get-ChildItem -LiteralPath $src -Recurse -File) {
      $rel = $item.FullName.Substring($src.Length).TrimStart('\', '/')
      $target = Join-Path $dst $rel
      $targetDir = Split-Path -Parent $target
      if (-not (Test-Path -LiteralPath $targetDir)) {
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
      }

      $exists = Test-Path -LiteralPath $target
      # On a patch release most of the tree (node_modules/, assets/) is
      # untouched. Leaving those files alone keeps the number of displacements
      # — and therefore the number of ways this can fail — proportional to what
      # actually changed.
      if ($exists -and (Test-SameFile $item.FullName $target)) {
        $unchanged++
        continue
      }

      # Displace first, and only journal the entry once the original is safely
      # out of the way — a failed displacement leaves the file untouched, so it
      # must not appear in the rollback plan.
      $backup = $null
      if ($exists) {
        $backup = "$target.old-$($script:BackupStamp)"
        try {
          Move-Item -LiteralPath $target -Destination $backup -Force -ErrorAction Stop
        } catch {
          Fail ("failed to displace $target (locked and could not be moved aside). " +
            "Close atomic-agent and re-run the installer.`n  $($_.Exception.Message)")
        }
      }
      [void]$journal.Add([pscustomobject]@{ Target = $target; Backup = $backup })
      Copy-Item -LiteralPath $item.FullName -Destination $target -Force -ErrorAction Stop
    }
  } catch {
    Undo-TreeTransaction $journal
    throw
  }
  Write-Info "replaced $($journal.Count) file(s), $unchanged unchanged"
  Remove-TransactionBackups $journal
}

# Only win32-x64 is published today. On ARM64 Windows the x64 build still runs
# under the OS x64 emulation layer, so we install it and warn.
$archRaw = $env:PROCESSOR_ARCHITECTURE
if ($archRaw -and $archRaw -ne "AMD64") {
  Write-Info "note: detected PROCESSOR_ARCHITECTURE=$archRaw; only a win32-x64 build is published."
  Write-Info "      it will run through the Windows x64 emulation layer."
}
$Slug = "win32-x64"
$ArchiveName = "atomic-agent-$Slug.zip"

$Base = "https://github.com/$Repo"
if ($Version) {
  $ZipUrl = "$Base/releases/download/$Version/$ArchiveName"
  $ShaUrl = "$Base/releases/download/$Version/$ArchiveName.sha256"
} else {
  $ZipUrl = "$Base/releases/latest/download/$ArchiveName"
  $ShaUrl = "$Base/releases/latest/download/$ArchiveName.sha256"
}

Write-Info "downloading $ArchiveName from $Repo ..."

$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("atomic-agent-install-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $Work -Force | Out-Null

try {
  $ZipPath = Join-Path $Work $ArchiveName
  $ShaPath = "$ZipPath.sha256"

  Get-RemoteFile $ZipUrl $ZipPath
  Get-RemoteFile $ShaUrl $ShaPath

  # The .sha256 file is `shasum -a 256`-style: "<hex>  <filename>".
  $expected = ((Get-Content -Path $ShaPath -Raw).Trim() -split '\s+')[0].ToLower()
  if (-not $expected) {
    Fail "could not read expected checksum from $ArchiveName.sha256"
  }
  $actual = (Get-FileHash -Path $ZipPath -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expected) {
    Fail "checksum mismatch for $ArchiveName`n  expected: $expected`n  actual:   $actual"
  }
  Write-Info "checksum verified"

  # Extract into a fresh staging dir. The Windows zip stores files at its root
  # (no top-level <slug>/ wrapper), unlike the Unix tarball.
  $Stage = Join-Path $Work "stage"
  New-Item -ItemType Directory -Path $Stage -Force | Out-Null
  Expand-Archive -Path $ZipPath -DestinationPath $Stage -Force

  $BinaryPath = Join-Path $Stage "atomic-agent.exe"
  if (-not (Test-Path $BinaryPath)) {
    Fail "binary atomic-agent.exe not found in archive $ArchiveName"
  }

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

  # Self-update-safe install: drop stale backups from a previous update, then
  # apply the staged tree as an all-or-nothing transaction that displaces
  # locked files (the running .exe / loaded .node) instead of failing. This
  # lets an already-running install upgrade itself; relaunch afterwards to run
  # the new binary.
  Remove-StaleBackups $InstallDir
  Copy-TreeTransactional $Stage $InstallDir

  # Short alias: `atag` is the same CLI under a shorter name. A .cmd shim
  # rather than a copy of the (large) SEA binary, and rather than a symlink,
  # which needs an elevated shell or Developer Mode. %~dp0 resolves to the
  # directory of the shim, so it always launches the atomic-agent.exe sitting
  # next to it and asset resolution is unaffected. Rewritten on every install,
  # so it self-heals and needs no place in the transactional copy.
  Set-Content -LiteralPath (Join-Path $InstallDir "atag.cmd") -Encoding ASCII -Value @(
    "@echo off",
    "`"%~dp0atomic-agent.exe`" %*"
  )

  Write-Info ""
  Write-Info "installed atomic-agent to $InstallDir\atomic-agent.exe"
  Write-Info "(plus the short alias 'atag' next to it)"
}
catch {
  # A bare PowerShell error record is unreadable when the in-app updater
  # forwards it line by line into the TUI feed, so emit the reason as plain
  # text. Rollback (when the failure happened mid-transaction) already ran.
  Write-Info "error: $($_.Exception.Message)"
  exit 1
}
finally {
  Remove-Item -Path $Work -Recurse -Force -ErrorAction SilentlyContinue
}

$script:PathStatus = "added"

function Add-ToUserPath($dir) {
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $current) { $current = "" }
  $entries = $current -split ';' | Where-Object { $_ -ne "" }
  foreach ($e in $entries) {
    if ($e.TrimEnd('\') -ieq $dir.TrimEnd('\')) {
      Write-Info "PATH already contains $dir"
      $script:PathStatus = "present"
      return
    }
  }
  if ($env:ATOMIC_AGENT_NO_PATH -eq "1") {
    Write-Info "add to PATH manually (PowerShell):"
    Write-Info "  [Environment]::SetEnvironmentVariable('Path', `"$dir;`$([Environment]::GetEnvironmentVariable('Path','User'))`", 'User')"
    $script:PathStatus = "manual"
    return
  }
  $sep = if ($current.Length -gt 0 -and -not $current.EndsWith(';')) { ";" } else { "" }
  $updated = "$current$sep$dir"
  [Environment]::SetEnvironmentVariable("Path", $updated, "User")
  # Reflect in the current session too so `atomic-agent` works right away.
  $env:Path = "$env:Path;$dir"
  Write-Info "added $dir to user PATH"
  $script:PathStatus = "added"
}

Add-ToUserPath $InstallDir

Write-Info ""
switch ($script:PathStatus) {
  "present" {
    Write-Info "to run:"
    Write-Info "  atomic-agent"
    Write-Info "  atag           # same thing, shorter"
  }
  "manual" {
    Write-Info "atomic-agent is NOT on your PATH yet."
    Write-Info "add $InstallDir to your PATH, then run:"
    Write-Info "  atomic-agent"
    Write-Info "  atag           # same thing, shorter"
  }
  default {
    Write-Info "atomic-agent was added to your PATH."
    Write-Info "it works in THIS terminal now; open a NEW terminal elsewhere, then run:"
    Write-Info "  atomic-agent"
    Write-Info "  atag           # same thing, shorter"
  }
}
