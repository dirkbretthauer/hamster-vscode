---
name: "speckit-git-branch"
description: "Create and switch to the git feature branch for a Spec Kit feature. Runs as the before_specify hook."
argument-hint: "Feature description (optionally GIT_BRANCH_NAME=<name> or SHORT_NAME=<name>)"
compatibility: "Requires spec-kit project structure with .specify/ directory and a git repository"
metadata:
  author: "hamster-vscode"
  source: ".specify/scripts/powershell/create-feature-branch.ps1"
user-invocable: true
disable-model-invocation: false
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Purpose

Create (or switch to) the git branch for a Spec Kit feature, so that feature work never starts
on `main`. This is the `before_specify` hook registered in `.specify/extensions.yml`; it is also
usable on its own when a spec already exists but its branch does not.

This command touches **git only**. The spec directory and `spec.md` are always created by
`/speckit-specify` itself — never by this hook.

## Inputs

The argument text is the feature description. These optional markers may appear in it, or be
passed through by the caller:

- `GIT_BRANCH_NAME=<name>` — use this exact branch name and skip all name generation.
- `SHORT_NAME=<name>` — a 2-4 word short name to use as the branch suffix.
- `FEATURE_NUMBER=<n>` — prefer this feature number instead of auto-detecting the next one.

## Execution

1. Derive the arguments for the script:
   - If the caller supplied `GIT_BRANCH_NAME`, pass `-BranchName <value>` and nothing else that
     affects naming.
   - Otherwise, generate a 2-4 word short name from the feature description the same way
     `/speckit-specify` does (action-noun format, keep technical terms and acronyms) and pass it
     as `-ShortName`. If the caller supplied `SHORT_NAME`, use that value verbatim instead.
   - If the caller supplied `FEATURE_NUMBER`, pass `-Number <value>`.
   - If the spec directory for this feature **already exists** (you are adding a branch to a spec
     that was written before this hook existed), also pass `-AllowExistingBranch` so the existing
     number is reused instead of being bumped.
2. Run the script from the repository root:

   ```powershell
   .specify/scripts/powershell/create-feature-branch.ps1 -Json -ShortName '<short-name>' '<feature description>'
   ```

   Parse the single-line JSON it prints on stdout. Informational notes and warnings go to stderr.

3. Report the result and **output the JSON object** so the calling command can read
   `BRANCH_NAME` and `FEATURE_NUM` from it:

   | Field | Meaning |
   |-------|---------|
   | `BRANCH_NAME` | The branch now checked out |
   | `FEATURE_NUM` | The feature number embedded in the branch name (may be empty for a custom `GIT_BRANCH_NAME`) |
   | `BASE_BRANCH` | The branch the new branch was created from |
   | `BRANCH_CREATED` | `true` if a new branch was created, `false` if an existing one was reused |
   | `ALREADY_ON_BRANCH` | `true` if the branch was already checked out, so nothing changed |
   | `GIT_AVAILABLE` | `false` if this is not a git repository; the branch was skipped |

## Rules

- **Never create the spec directory or `spec.md`.** That is `/speckit-specify`'s job. Creating
  either here makes the two numbering paths disagree.
- **Never commit, stage, push, or stash.** Uncommitted work deliberately follows the checkout onto
  the new branch; the script reports how many changes moved.
- **Do not fail the specify flow when there is no git repository.** The script warns and reports
  `GIT_AVAILABLE: false`; say so plainly and let the spec be written anyway.
- **Do not invent a branch name when the script fails.** Report the error and stop, so the user
  can decide.
- Branch naming is owned by `create-new-feature.ps1 -DryRun`, which the script calls. Do not
  reimplement the numbering or stop-word filtering here — it would drift from the spec directory
  name.

## Done When

- [ ] The feature branch is checked out (or the no-git case is reported)
- [ ] The JSON result, including `BRANCH_NAME` and `FEATURE_NUM`, is reported to the caller
