# VS Code Port — Spec Conformance Status

## Scope
Tracks how well `hamster-vscode` (this repo) implements the behavior documented in the original Java
application's specs, located in the sibling repo:
`hamstersimulator-v29-06-eclipse/hamstersimulator-2.9.6/spec/` (`hamster-language.md`, `domain-model.md`,
`simulation-ui.md`, `console.md`, `editor.md`, `compiler-pipeline.md`, `debugger-ui.md`,
`alternate-frontends.md`, `platform-concerns.md`, `architecture.md`).

This is a living checklist derived from a full-codebase review (see review date below). Update it as items
are fixed. Each finding that warrants standalone tracking is linked to a GitHub issue once filed (see
"Issue Filing" at the end — issue numbers to be filled in once created, since this environment could not
create them automatically).

**Review date:** 2026-09-20
**Reviewed against:** `hamster-vscode` v0.4.0 (`package.json`), full `src/` + `lang/` + `syntaxes/`.

## Executive Summary
The port is architecturally sound and, in the debugger/diagnostics area, **exceeds** the original (real
persistent breakpoints, live squiggle diagnostics — the original had neither). The weakest area is **language
conformance**: the custom JS lexer/parser/runner in `lang/` covers most of Band 1 (imperative) but only a
small fraction of Band 2 (the full Java-like OO/exception/concurrency model documented in
`hamster-language.md`).

| Area | Spec doc(s) | Status |
| --- | --- | --- |
| Editor & syntax highlighting | `editor.md` | 🟢 Appropriate simplification via native VS Code + TextMate grammar |
| Terrain custom editor (`.ter`) | `simulation-ui.md`, `domain-model.md` | 🟡 Mostly compatible, some gaps |
| Simulation rendering | `simulation-ui.md` | 🟡 Functional, missing zoom + per-hamster color sprites |
| Console/Terminal I/O | `console.md` | 🟢 Reasonably simplified (log panel + cooperative input) |
| Compiler pipeline | `compiler-pipeline.md` | 🟡 "Compile" is parse-validate only; no program-type marker handling |
| Debugger | `step-mechanism.md`, `debugger-ui.md` | 🟢 Real breakpoints (improvement); 🟡 step-in/out not distinct |
| Hamster language — Band 1 | `hamster-language.md` | 🟡 ~70–75% complete |
| Hamster language — Band 2 (OO) | `hamster-language.md` | 🔴 ~15–25% complete |
| Alternate frontends / 3D / i18n | `alternate-frontends.md`, `platform-concerns.md` | 🟢 Correctly out of scope, no confusing remnants |

## Detailed Findings

### 1. Language: Lexer (`lang/hamster-lexer.js`)
- 🔴 Missing keywords: `switch`, `case`, `default`, `break`, `try`, `catch`, `throw`, `instanceof`, `super`, `abstract`.
- 🔴 Missing compound-assignment operators `+=`, `-=`.
- 🟡 Identifier grammar excludes `$` (spec allows `[A-Za-z_$][A-Za-z0-9_$]*`).
- 🟡 Unknown string escapes are silently accepted (drops backslash) instead of raising a lexical error.
- 🟢 Core Band-1 keywords, comments, numeric/boolean/null/string literals, common operators all present.

### 2. Language: Parser (`lang/hamster-parser.js`)
- 🟢 Full Band 1 statement/expression grammar: `if/else`, `while`, `do/while`, `for` (desugared), `return`, blocks, calls, member access, indexing, postfix `++`/`--`.
- 🔴 No real class AST: "compatibility mode" scans class/interface headers and discards name, `extends`, `implements`, fields, constructors, modifiers — only flattens methods into the global function list.
- 🔴 No `super`, `instanceof`, casts, `switch/case/break`, `try/catch/throw`, `abstract`.
- 🟡 Prefix `++`/`--` not parsed (only postfix).
- 🟡 Array creation (`new Type[n]`) parses multi-dimensional syntax but the parser/runner combination only really supports one dimension.
- 🟡 Unsupported top-level syntax can be silently skipped in non-strict compatibility mode rather than reported as an error.

### 3. Language: Runner/Interpreter (`lang/hamster-runner.js`)
- 🔴 **Bug:** binary `+` always does `Number(left) + Number(right)` — string concatenation (`"a"+"b"`) produces `NaN` instead of `"ab"`.
- 🔴 Postfix `++`/`--` only supports plain identifiers (`arr[i]++`, `this.x++` fail).
- 🔴 No exception system: no `HamsterException` hierarchy, no catchable `MauerDaException`/`WallInFrontException`/etc. — runtime errors are fatal, not catchable via (nonexistent) `try/catch`.
- 🟡 English API aliases (`move`, `turnLeft`, `pickGrain`, `putGrain`, `frontIsClear`, `grainAvailable`, `mouthEmpty`, `write`, `readNumber`, `readString`) are largely absent from `KNOWN_BUILTINS`; only German names dispatch reliably. `readInt` is used instead of spec's `readNumber`.
- 🟡 No `Territorium`/`Territory` static API, no direction/color constants beyond ad-hoc `NORD/OST/SUED/WEST` in `createRuntime()`.
- 🟡 No `start()`/`run()` concurrency — single hamster, single generator, single synthetic DAP thread.
- 🟡 Program-type markers (`/*imperative program*/`, `/*object-oriented program*/`, `/*class*/`) are discarded as ordinary comments; no differentiated semantics.
- ⚪ Hardcoded loop-iteration (~100k) and recursion-depth (~256) guards not in the original spec — reasonable safety net, but undocumented for users.

### 4. Simulation Rendering (`hamsterPanel.ts` webview)
- 🟡 No zoom control — fixed `CELL = 48`px; spec (`simulation-ui.md`) describes a 32px default with ±4 zoom steps.
- 🟡 All hamsters render with the same 4 direction sprites (`assets/hamster{north,south,east,west}.png`); the `COLORS` palette only applies in the image-failed-to-load circle fallback, not the primary rendering path — no true per-hamster-color visuals as in the original's `ColorFilter`-recolored sprites.
- 🟡 `.ter` loading only ever updates the single default hamster (`id:-1`) for each direction marker; multiple direction markers in one file do not spawn independent hamsters.
- 🟢 Terrain/corn/wall model (width/height/walls/corn grids, default hamster id -1) matches `domain-model.md` semantics.

### 5. Terrain Editor (`terrainEditor.ts`)
- 🟡 No UI to edit the default hamster's mouth/corn inventory.
- 🟢 `setWall()` prevents placing a wall under any hamster and clears the cell's corn count when a wall is placed, matching the original terrain-editing invariants.
- 🟡 Width/height inputs don't refresh to reflect a loaded `.ter` file's actual dimensions (canvas resizes correctly; text inputs stay stale).
- 🟡 Malformed/short `.ter` files silently fall back to a default 10×8 terrain with no user-visible error.
- 🟢 On-disk `.ter` format (dimensions, wall/corn grid, corn-count lines, mouth count) is compatible with the original — existing original `.ter` files should load correctly for the common case.

### 6. Console / Terminal I/O
- 🟢 `schreib`/output routed to a webview log panel — a reasonable, simpler substitute for the original's threaded `Console`.
- 🟢 `liesZahl`/`liesZeichenkette` implemented via a cooperative pause (`needsInput`/`provideInput`) rather than a modal `DialogTerminal` — architecturally simpler and appropriate for a single-threaded JS interpreter.

### 7. Compiler Pipeline Equivalent
- 🟡 `hamster.compile` command is a **strict parse/validate** (`requireMain: true, strict: true`), not a real compilation step — reasonable given there's no bytecode target, but should be labeled/documented as "Check" rather than "Compile" to avoid confusing users familiar with the original.
- 🔴 Program-type markers are not detected, stripped, or used to select parsing/wrapping behavior (see finding 3 above).
- 🟡 Live diagnostics (`diagnostics.ts`) report only the **first** parse error, with a fixed 10-column-wide range that can overshoot short lines.
- 🟡 `new Function()` is used in `diagnostics.ts` to eval the bundled lexer+parser JS at runtime in the extension host — a maintainability/code-smell concern (not a real vulnerability since the code is extension-bundled, not user-supplied), better replaced with a static import/bundle step.

### 8. Debugger (`hamsterDebugSession.ts` + debug bridge in `hamsterPanel.ts`)
- 🟢 **Real, persistent, user-settable breakpoints** — a genuine improvement over the original app, which had none (`debugger-ui.md`).
- 🟢 Stack trace / scopes / variables implemented via interpreter-maintained frames — functions even without a JDI equivalent.
- 🟡 `next`, `stepIn`, and `stepOut` all currently perform the *same* single AST-statement advance — no call-depth-aware step-out/step-over distinction.
- 🟡 Breakpoints are always reported `verified: true` without checking the line is executable; checked only during `continue`, not during single-stepping.
- 🟡 `evaluate` (DAP hover/watch) only resolves bare identifiers — no expression evaluation.
- 🟡 No object/array expansion in the variables view (`variablesReference` always 0).

### 9. Explicitly Out of Scope (confirmed clean)
No confusing partial/stub remnants found for: Scheme/JavaScript/Python/Ruby/Prolog consoles, Scratch/FSM/Flowchart visual editors, LEGO integration, 3D/OpenGL view, or Java-style multi-locale i18n bundles. Per `alternate-frontends.md`/`platform-concerns.md`, these are reasonable scope cuts for this port.

## Prioritization for Fixes
1. **P0 — correctness bugs likely to confuse users immediately:** string concatenation (`"a"+"b"` → `NaN`), postfix `++`/`--` restricted to identifiers, wall-under-hamster placement.
2. **P1 — core language gaps blocking Band 2 curriculum content:** real classes/inheritance/interfaces/constructors, `try/catch/throw` + exception hierarchy, `switch/case/break`, English API aliases, `+=`/`-=`, prefix `++`/`--`.
3. **P2 — fidelity/UX gaps:** zoom controls, per-hamster color sprites, multi-hamster `.ter` loading, program-type marker handling, step-in/out distinction, terrain editor mouth-count UI.
4. **P3 — polish/maintainability:** `new Function()` replacement, multi-error diagnostics, breakpoint verification, expression evaluation in debugger.

## Issue Filing
All 18 items are filed as GitHub issues in [`dirkbretthauer/hamster-vscode`](https://github.com/dirkbretthauer/hamster-vscode/issues),
labeled `spec-conformance` plus a priority label (`P0`–`P3`).

| Issue | Title | Priority |
| --- | --- | --- |
| [#1](https://github.com/dirkbretthauer/hamster-vscode/issues/1) | String concatenation with `+` produces `NaN` instead of concatenating | P0 |
| [#2](https://github.com/dirkbretthauer/hamster-vscode/issues/2) | Postfix `++`/`--` fails on non-identifier targets (`arr[i]++`, `this.x++`) | P0 |
| [#3](https://github.com/dirkbretthauer/hamster-vscode/issues/3) | Terrain editor allows placing a wall under an existing hamster | P0 |
| [#4](https://github.com/dirkbretthauer/hamster-vscode/issues/4) | No real class/inheritance/interface/constructor support (Band 2 OO) | P1 |
| [#5](https://github.com/dirkbretthauer/hamster-vscode/issues/5) | No `try`/`catch`/`throw` or Hamster exception hierarchy | P1 |
| [#6](https://github.com/dirkbretthauer/hamster-vscode/issues/6) | Missing `switch`/`case`/`default`/`break` | P1 |
| [#7](https://github.com/dirkbretthauer/hamster-vscode/issues/7) | English Hamster API aliases mostly unimplemented | P1 |
| [#8](https://github.com/dirkbretthauer/hamster-vscode/issues/8) | Missing compound assignment (`+=`, `-=`) and prefix `++`/`--` | P1 |
| [#9](https://github.com/dirkbretthauer/hamster-vscode/issues/9) | No zoom controls in simulation view | P2 |
| [#10](https://github.com/dirkbretthauer/hamster-vscode/issues/10) | Hamsters don't render in distinct colors (per-hamster sprite recoloring missing) | P2 |
| [#11](https://github.com/dirkbretthauer/hamster-vscode/issues/11) | `.ter` loading only supports a single (default) hamster, ignores multiple direction markers | P2 |
| [#12](https://github.com/dirkbretthauer/hamster-vscode/issues/12) | Program-type markers (`/*imperative program*/` etc.) are ignored | P2 |
| [#13](https://github.com/dirkbretthauer/hamster-vscode/issues/13) | Debugger `stepIn`/`stepOut`/`next` are not behaviorally distinct | P2 |
| [#14](https://github.com/dirkbretthauer/hamster-vscode/issues/14) | Terrain editor has no UI to set default hamster's mouth/corn count | P2 |
| [#18](https://github.com/dirkbretthauer/hamster-vscode/issues/18) | Replace `new Function()` eval of bundled parser in `diagnostics.ts` | P3 |
| [#19](https://github.com/dirkbretthauer/hamster-vscode/issues/19) | Placing a wall does not clear corn underneath it | P1 |
| [#15](https://github.com/dirkbretthauer/hamster-vscode/issues/15) | Diagnostics only report the first parse error, with an inaccurate fixed-width range | P3 |
| [#16](https://github.com/dirkbretthauer/hamster-vscode/issues/16) | Debugger breakpoints always reported as verified without executable-line validation | P3 |
| [#17](https://github.com/dirkbretthauer/hamster-vscode/issues/17) | Debugger `evaluate` only supports bare identifiers, not expressions | P3 |
