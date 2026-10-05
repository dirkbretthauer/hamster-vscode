# Contract: `npm run conformance` (scripts/conformance.cjs)

Extends the existing command. New behavior is marked **new**.

## Invocation

```text
node scripts/conformance.cjs [referenceDir] [--verbose] [--min-pass-rate=<0..1>]
npm run conformance -- [referenceDir] [--verbose] [--min-pass-rate=<0..1>]
```

- `referenceDir`: defaults to `$HAMSTER_REFERENCE_DIR`, then the AGENTS.md location.
- `--verbose`: lists every failing and known-gap file, not just the first 3 per group.
- `--min-pass-rate`: the gate is applied to `passed / (passed + failed)`, which **excludes known gaps (new)**.

## Output (stdout)

1. A per-program-type table: `Passed`, `Failed`, **`Known gaps` (new)**, `Rate`, then a `TOTAL` row.
2. A `Skipped (not Java-like)` line.
3. **`Known gaps (out of scope)` section (new)**: grouped by `unsupportedConstruct` code with counts and example
   `file:line`.
4. `Failures by message`: the existing format, now containing regressions or remaining in-scope failures only.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | completed; the gate (if given) is met |
| 1 | unexpected script error |
| 2 | corpus directory not found |
| 3 | pass rate below `--min-pass-rate` |

## Target after this feature

`npm run conformance -- --min-pass-rate=1` exits 0. Known gaps are about 10, all with one of the six codes.
