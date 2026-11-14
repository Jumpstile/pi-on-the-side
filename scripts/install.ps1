# Pi on the Side: the one-line installer (attach this file to every release).
#
#   gh release download (gh api --hostname github.com 'repos/Jumpstile/pi-on-the-side/releases?per_page=1' --jq '.[0].tag_name') -R github.com/Jumpstile/pi-on-the-side -p install.ps1 -O - | iex
#
# It finds the newest release (prereleases included, the same rule the updater and Start use), downloads the update
# bundle with the GitHub CLI, checks its sha256 against the digest GitHub published, and only then runs the bundle's
# own `install` command. Nothing is installed if a step before that fails. Once the bundle's install has started, a
# problem it reports leaves what it finished, and running pots install again is safe. It needs Node.js 22+ and the
# GitHub CLI (gh) already logged in; it asks nothing else.
$ErrorActionPreference = 'Stop'
# The repository and the host are fixed on purpose: the pasted line names github.com itself (--hostname, -R github.com/...), the script forces
# GH_HOST to github.com for every gh call it makes (and puts the person's own value back when it ends), and no environment
# variable, URL or mirror can redirect where the code comes from. Every gh call has a time limit and a cap on its output.
$repo = 'Jumpstile/pi-on-the-side'
$oldHost = $env:GH_HOST; $oldPrompt = $env:GH_PROMPT_DISABLED
$env:GH_HOST = 'github.com'; $env:GH_PROMPT_DISABLED = '1'
$failed = $false
function Invoke-Gh([string[]]$GhArgs, [int]$Seconds = 120, [int]$MaxChars = 4194304) {
    $job = Start-Job -ScriptBlock { param($a) $out = & gh @a 2>$null; [pscustomobject]@{ Code = $LASTEXITCODE; Text = (@($out) -join "`n") } } -ArgumentList (, $GhArgs)
    try {
        if (-not (Wait-Job -Job $job -Timeout $Seconds)) { Stop-Job -Job $job; return [pscustomobject]@{ Code = 1; Text = '' } }
        $r = Receive-Job -Job $job
    } finally { Remove-Job -Job $job -Force -ErrorAction SilentlyContinue }
    if ($null -eq $r -or $r.Text.Length -gt $MaxChars) { return [pscustomobject]@{ Code = 1; Text = '' } }
    return $r
}
$work = Join-Path ([IO.Path]::GetTempPath()) ('pots-' + [guid]::NewGuid().ToString('N'))
# Semantic Versioning order, as in src/update.mjs: a release is newer than its own prereleases. Numbers have no leading zeros.
function Compare-Number($x, $y) { if ($x.Length -ne $y.Length) { return $x.Length - $y.Length }; return [string]::CompareOrdinal($x, $y) }
function Compare-Version($a, $b) {
    for ($i = 1; $i -le 3; $i++) { $c = Compare-Number $a.Groups[$i].Value $b.Groups[$i].Value; if ($c -ne 0) { return $c } }
    $x = $a.Groups[4].Value; $y = $b.Groups[4].Value
    if (-not $x -or -not $y) { return [int](-not $x) - [int](-not $y) }
    $p = $x.Split('.'); $q = $y.Split('.')
    for ($i = 0; $i -lt [Math]::Min($p.Count, $q.Count); $i++) {
        $m = $p[$i] -match '^[0-9]+$'; $n = $q[$i] -match '^[0-9]+$'
        if ($m -and $n) { $c = Compare-Number $p[$i] $q[$i] } elseif ($m -or $n) { $c = if ($m) { -1 } else { 1 } } else { $c = [string]::CompareOrdinal($p[$i], $q[$i]) }
        if ($c -ne 0) { return $c }
    }
    return $p.Count - $q.Count
}
$semver = '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?\z'
try {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'The GitHub CLI (gh) was not found. Install it from https://cli.github.com, run gh auth login, then run this line again.' }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js was not found. Install Node.js 22 or newer from https://nodejs.org, then run this line again.' }
    # Every release, at most 5 pages of 100 (the updater's bound). Drafts and tags that are not v<semver> are not Pi on the Side releases.
    $best = $null; $bestMatch = $null; $complete = $false
    for ($page = 1; $page -le 5 -and -not $complete; $page++) {
        $reply = Invoke-Gh @('api', '-H', 'Accept: application/vnd.github+json', '--method', 'GET', '-f', 'per_page=100', '-f', "page=$page", "repos/$repo/releases")
        $text = $reply.Text
        if ($reply.Code -ne 0 -or -not $text) { throw 'Could not read the list of releases. Check your internet connection and that you are logged in to GitHub with an account that can see this repository (gh auth login), then run this line again.' }
        $parsed = ConvertFrom-Json -InputObject $text
        $batch = @(@($parsed) | Where-Object { $null -ne $_ })
        foreach ($entry in $batch) {
            $tag = [string]$entry.tag_name
            if ($entry.draft -ne $false -or $tag.Length -gt 65) { continue }
            $match = [regex]::Match($tag, $semver)
            if (-not $match.Success) { continue }
            $order = if ($best) { Compare-Version $match $bestMatch } else { 1 }
            if ($order -eq 0) { throw 'Two releases have the same version, so nothing was installed.' }
            if ($order -gt 0) { $best = $entry; $bestMatch = $match }
        }
        if ($batch.Count -lt 100) { $complete = $true }
    }
    if (-not $complete) { throw 'More than 500 releases are listed, so nothing was installed.' }
    if (-not $best) { throw 'No Pi on the Side release was found. Ask whoever gave you this line to publish one, then run this line again.' }
    $release = $best
    $version = $release.tag_name.Substring(1)
    $name = 'omp-session-bridge-' + $version + '.zip'
    $asset = @($release.assets | Where-Object { $_.name -eq $name })
    if ($asset.Count -ne 1) { throw "The release must have exactly one file named $name, so nothing was installed." }
    $digest = [string]$asset[0].digest
    if ($asset[0].size -lt 1 -or $asset[0].size -gt 4MB -or $digest -notmatch '^sha256:[0-9a-f]{64}$') { throw 'The release file has no usable size or checksum, so nothing was installed.' }
    New-Item -ItemType Directory -Path $work | Out-Null
    $zip = Join-Path $work $name
    $download = Invoke-Gh @('release', 'download', $release.tag_name, '--repo', $repo, '--pattern', $name, '--output', $zip) 300
    if ($download.Code -ne 0 -or -not (Test-Path -LiteralPath $zip)) { throw 'The download did not finish. Check your internet connection, then run this line again.' }
    if ((Get-Item -LiteralPath $zip).Length -ne $asset[0].size) { throw 'The download does not have the published size, so nothing was installed.' }
    $actual = 'sha256:' + (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $digest) { throw 'The download does not match its published checksum, so nothing was installed.' }
    Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $work 'bundle')
    & node (Join-Path $work 'bundle\bin\bridge.mjs') install
    if ($LASTEXITCODE -ne 0) { Write-Host 'Setup reported a problem. The lines above say what it is and what to do; running pots install again is safe.'; $global:LASTEXITCODE = 1; $failed = $true }
} catch {
    Write-Host ('Pi on the Side was not installed. ' + $_.Exception.Message)
    $global:LASTEXITCODE = 1; $failed = $true
} finally {
    $env:GH_HOST = $oldHost; $env:GH_PROMPT_DISABLED = $oldPrompt
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
# Run as a file the exit code says it; pasted into a window (iex) an exit would close the person's own window, so only the variable is set.
if ($failed -and $MyInvocation.MyCommand.Path) { exit 1 }
