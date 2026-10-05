# Quickstart: Validating Full Sample-Program Parsing

**Feature**: [spec.md](./spec.md) | **Contracts**: [ast-nodes](./contracts/ast-nodes.md),
[conformance CLI](./contracts/conformance-cli.md)

## Prerequisites

- `npm ci` has been run (TypeScript is needed by the unit tests).
- For the corpus checks: the reference simulator at the AGENTS.md path, or `HAMSTER_REFERENCE_DIR` set.

> In PowerShell, `npm run x -- --flag` may drop the flags. Call the script directly with
> `node scripts/conformance.cjs …` as shown below.

## 1. In-repo regression tests (no corpus needed): SC-004, SC-005, FR-018

```text
npm test
```

**Expected**: `Language smoke checks passed`, then all `node --test` suites pass, in under 10 seconds total. The
smoke suite contains a parse case for every requested construct and an execution case for `finally`, multiple
`catch`, `instanceof`, array initializers, erasure, and `synchronized`.

## 2. Corpus gate: SC-001, SC-002, FR-017, FR-019

```text
node scripts/conformance.cjs --min-pass-rate=1
```

**Expected**: exit code 0. `TOTAL` shows `Failed 0` at 100.0%, and `Passed` is ≥ 808 (no regressions; about 910
in-scope programs). The `Known gaps (out of scope)` section lists about 10 programs, each with one of
`qualified-type-name`, `multiple-declarators`, `enum`, `class-literal`, `long-literal`, or `enhanced-for`.

Use `node scripts/conformance.cjs --verbose` to list every known-gap file.

## 3. Regression check: SC-005

Temporarily make the parser reject `finally`, for example by commenting out the `finally` branch. Then:

```text
npm test                                        → fails (smoke parse test for finally)
node scripts/conformance.cjs --min-pass-rate=1  → exit code 3, the finally programs are listed under failures
```

Revert the change afterwards.

## 4. Build: constitution quality gate

```text
npm run compile
```

**Expected**: all five webpack bundles compile successfully.

## 5. Manual check in the Extension Development Host: SC-003, constitution Principle V

Press F5 and open these samples from `<reference>/Programme/beispielprogramme/`:

| Construct | Sample | Expected |
|---|---|---|
| `finally` | `band 2/kapitel 13/abschnitt 5 beispiel 4/hamsterprogramm.ham` | no Problems; Run executes the `finally` block (the hamster turns back) |
| multiple `catch` | `band 2/kapitel 13/beispielprogramm 1/hamsterprogramm.ham` | no Problems; the matching `catch` handles the error |
| `instanceof` | `band 2/kapitel 11/abschnitt 10/Sammeln.ham` | no Problems; runs |
| generics | `band 2/kapitel 15/beispielprogramm 1/hamsterprogramm1.ham` | no Problems; runs with `Speicher<Integer>` |
| `synchronized` / array initializer | `band 3/kapitel 12/abschnitt 12.3/BinaerSemaphor3.ham` | no Problems; Run stops with a clear "threads are not supported" message if it starts threads |
| known gap | `band 2/kapitel 6/abschnitt 9/beispiel1.ham` (`enum`) | one error: "enum declarations are not supported" |

Check that `synchronized`, `finally`, and `instanceof` are highlighted as keywords. Then repeat one sample in the
Web Extension Host (`Developer: Open Web Extension Host`).
