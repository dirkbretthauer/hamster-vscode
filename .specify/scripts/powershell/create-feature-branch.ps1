#!/usr/bin/env pwsh
# Create (or switch to) the git feature branch for a Spec Kit feature.
#
# Runs as the `before_specify` hook. It only touches git: the spec directory and
# spec.md are always created by /speckit-specify itself. Branch naming is
# delegated to create-new-feature.ps1 -DryRun so the branch number and the spec
# directory number are produced by one implementation and cannot drift apart.
[CmdletBinding()]
param(
    [switch]$Json,
    [string]$ShortName,
    [string]$BranchName,
    [Parameter()]
    [string]$Number = '',
    [switch]$Timestamp,
    [switch]$AllowExistingBranch,
    [switch]$DryRun,
    [switch]$Help,
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]]$FeatureDescription
)
$ErrorActionPreference = 'Stop'

if ($Help) {
    Write-Host "Usage: ./create-feature-branch.ps1 [-Json] [-ShortName <name>] [-BranchName <name>] [-Number N] [-Timestamp] [-AllowExistingBranch] [-DryRun] <feature description>"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  -Json                 Output in JSON format"
    Write-Host "  -ShortName <name>     Short name (2-4 words) used as the branch suffix"
    Write-Host "  -BranchName <name>    Use this exact branch name; skips all name generation"
    Write-Host "  -Number N             Prefer a feature number instead of auto-detecting the next one"
    Write-Host "  -Timestamp            Use a timestamp prefix (YYYYMMDD-HHMMSS) instead of sequential numbering"
    Write-Host "  -AllowExistingBranch  Reuse the number of an existing spec directory (for specs created before this hook)"
    Write-Host "  -DryRun               Report the branch that would be used without touching git"
    Write-Host "  -Help                 Show this help message"
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  ./create-feature-branch.ps1 -Json -ShortName 'user-auth' 'Add user authentication'"
    Write-Host "  ./create-feature-branch.ps1 -Json -BranchName 'hotfix/payment-timeout' 'Fix payment timeout'"
    exit 0
}

. "$PSScriptRoot/common.ps1"

$repoRoot = Get-RepoRoot
Set-Location $repoRoot

# Resolve the branch name, either verbatim from -BranchName or from the shared
# naming logic in create-new-feature.ps1.
$featureNum = ''
if ($BranchName) {
    $targetBranch = $BranchName
    # Honour the caller's exact value, but refuse a name git itself would reject
    # so the failure is reported here rather than as a raw git error later.
    & git check-ref-format --branch $targetBranch *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Error: '$targetBranch' is not a valid git branch name"
        exit 1
    }
    if ($targetBranch -match '(?:^|/)(\d{8}-\d{6}|\d{3,})-') {
        $featureNum = $matches[1]
    }
} else {
    if (-not $FeatureDescription -or $FeatureDescription.Count -eq 0) {
        Write-Error "Usage: ./create-feature-branch.ps1 [-Json] [-ShortName <name>] <feature description>"
        exit 1
    }

    # Hashtable splat, not an array: an array splat would pass every element
    # positionally, so the switches would be swallowed into the feature
    # description and the naming run would not be a dry run.
    $nameParams = @{ DryRun = $true; Json = $true }
    if ($ShortName) { $nameParams['ShortName'] = $ShortName }
    if ($PSBoundParameters.ContainsKey('Number') -and $Number -ne '') { $nameParams['Number'] = $Number }
    if ($Timestamp) { $nameParams['Timestamp'] = $true }
    if ($AllowExistingBranch) { $nameParams['AllowExistingBranch'] = $true }

    $naming = & "$PSScriptRoot/create-new-feature.ps1" @nameParams @FeatureDescription

    $parsed = $null
    if ($naming) {
        try {
            $parsed = ($naming | Out-String).Trim() | ConvertFrom-Json
        } catch {
            $parsed = $null
        }
    }
    if (-not $parsed -or -not $parsed.BRANCH_NAME) {
        Write-Error "Error: could not determine a branch name from the feature description"
        exit 1
    }

    $targetBranch = $parsed.BRANCH_NAME
    $featureNum = $parsed.FEATURE_NUM
}

if (-not $targetBranch) {
    Write-Error "Error: resolved branch name is empty"
    exit 1
}

# A missing git repository is not fatal: the spec is still worth writing, so
# report the branch that would have been used and let /speckit-specify continue.
& git rev-parse --git-dir *> $null
$inGitRepo = ($LASTEXITCODE -eq 0)

$baseBranch = ''
$branchCreated = $false
$alreadyOnBranch = $false

if (-not $inGitRepo) {
    [Console]::Error.WriteLine("[specify] Warning: not a git repository; skipping branch creation for '$targetBranch'")
} elseif ($DryRun) {
    $baseBranch = (& git rev-parse --abbrev-ref HEAD 2>$null)
} else {
    $baseBranch = (& git rev-parse --abbrev-ref HEAD 2>$null)

    if ($baseBranch -eq $targetBranch) {
        $alreadyOnBranch = $true
        [Console]::Error.WriteLine("[specify] Already on branch '$targetBranch'")
    } else {
        # Uncommitted work follows the checkout onto the new branch, which is
        # usually what you want when a feature is already underway. Say so
        # rather than blocking, so the hook never strands a half-finished
        # change. Only worth reporting when a switch actually happens.
        $dirtyEntries = @(& git status --porcelain)
        if ($dirtyEntries.Count -gt 0) {
            [Console]::Error.WriteLine("[specify] Note: $($dirtyEntries.Count) uncommitted change(s) will move with you to '$targetBranch'")
        }

        & git show-ref --verify --quiet "refs/heads/$targetBranch"
        $branchExists = ($LASTEXITCODE -eq 0)

        if ($branchExists) {
            & git switch $targetBranch
            if ($LASTEXITCODE -ne 0) {
                Write-Error "Error: could not switch to existing branch '$targetBranch'"
                exit 1
            }
            [Console]::Error.WriteLine("[specify] Switched to existing branch '$targetBranch'")
        } else {
            & git switch -c $targetBranch
            if ($LASTEXITCODE -ne 0) {
                Write-Error "Error: could not create branch '$targetBranch'"
                exit 1
            }
            $branchCreated = $true
            [Console]::Error.WriteLine("[specify] Created branch '$targetBranch' from '$baseBranch'")
        }
    }

    # Mirrors create-new-feature.ps1 so Get-CurrentBranch resolves the feature
    # for the rest of this session.
    $env:SPECIFY_FEATURE = $targetBranch
}

if ($Json) {
    $obj = [PSCustomObject]@{
        BRANCH_NAME       = $targetBranch
        FEATURE_NUM       = $featureNum
        BASE_BRANCH       = $baseBranch
        BRANCH_CREATED    = $branchCreated
        ALREADY_ON_BRANCH = $alreadyOnBranch
        GIT_AVAILABLE     = $inGitRepo
    }
    if ($DryRun) {
        $obj | Add-Member -NotePropertyName 'DRY_RUN' -NotePropertyValue $true
    }
    $obj | ConvertTo-Json -Compress
} else {
    Write-Output "BRANCH_NAME: $targetBranch"
    Write-Output "FEATURE_NUM: $featureNum"
    Write-Output "BASE_BRANCH: $baseBranch"
    Write-Output "BRANCH_CREATED: $branchCreated"
    Write-Output "ALREADY_ON_BRANCH: $alreadyOnBranch"
    Write-Output "GIT_AVAILABLE: $inGitRepo"
}
