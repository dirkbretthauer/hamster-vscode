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

**Update 2026-10-05 (feature `specs/001-full-sample-parsing`):** all 904 in-scope Java-like sample programs of
the reference simulator now parse (`node scripts/conformance.cjs --min-pass-rate=1`). The other 16 use
one of seven explicitly unsupported constructs and are reported as known gaps (see section 2).
The Java class library remains a runtime gap; cooperative concurrency is now supported (see the
2026-10-06 update below).

**Update 2026-10-05 (feature `specs/002-known-gap-constructs`):** the seven known-gap constructs are now
supported, so all 920 Java-like sample programs parse, with 0 known gaps.

**Update 2026-10-06 (feature `specs/003-cooperative-threads`):** a started hamster is now its own
cooperatively-scheduled thread, so the Band 3 chapter 10–12 teaching programs run. Of the 158
concurrency-using sample programs, **99 need nothing beyond threads and monitors** and are in scope
(`npm run concurrency-corpus`); 48 additionally need `util.AllroundHamster` (a pre-existing import
gap), 6 need `java.util.concurrent`/`Timer`, and 5 need collection classes. No syntax changed, so
the parse rate is unaffected.

Deviations from the reference, required by the constitution's reference-fidelity rule:

| Deviation | Reference behaviour | What this port does, and why |
| --- | --- | --- |
| Scheduling is cooperative, not pre-emptive | Real JVM threads, pre-empted anywhere | One hamster acts at a time, switching at hamster commands and blocking operations — exactly the points `IHamster._intern_sleep_200405()` marks. Keeps the webview responsive and the debugger coherent. |
| Interleaving is varied but not reproducible | Varied, via real thread scheduling | Weighted random choice among runnable threads. Deliberate: a fixed order would make unprotected programs always produce the right answer and hide the race the chapter 11 exercises teach. A consequence is that a failed run cannot be replayed by re-running it. |
| Priority means "picked more often" | `random() * (2 + MAX_PRIORITY - getPriority())` gives *higher*-priority threads more no-op yield points (`IHamster.java:76-85`) | Selection weight is the priority itself, so priority 10 is picked ten times as often as priority 1 and nobody is starved. The reference formula inverts the intuitive meaning and is an artefact of its Swing instruction pipeline. |
| `sleep`/timed `wait` use a simulation clock | Wall-clock milliseconds | Durations convert to scheduler steps (`STEPS_PER_MILLISECOND`). Wall-clock would make `Thread.sleep(2000)` expire instantly while single-stepping, making chapter 10.1's `stop.ham` undebuggable. |
| No `$_dibo_p_intern$` marker instruction | Pushes an invisible no-op through the processor to create extra preemption points | Dropped: it is an artefact of the Java UI pipeline (swallowed by `LogPanel.java:57` and `DialogTerminal.java:123`) with no counterpart here, and it would pollute the instruction log. |
| A breakpoint stops every thread | JDI can stop one thread | Cooperative execution means only one hamster is ever mid-action, so a stop-the-world snapshot is consistent. Stepping still advances the selected thread. |
| Thread count is capped | Unbounded | A documented limit keeps the editor responsive; it is far above anything the course material uses. |

| Area | Spec doc(s) | Status |
| --- | --- | --- |
| Editor & syntax highlighting | `editor.md` | 🟢 Appropriate simplification via native VS Code + TextMate grammar |
| Terrain custom editor (`.ter`) | `simulation-ui.md`, `domain-model.md` | 🟡 Mostly compatible, some gaps |
| Simulation rendering | `simulation-ui.md` | 🟡 Functional, missing per-hamster color sprites |
| Console/Terminal I/O | `console.md` | 🟢 Reasonably simplified (log panel + cooperative input) |
| Compiler pipeline | `compiler-pipeline.md` | 🟡 "Compile" is parse-validate only; no program-type marker handling |
| Debugger | `step-mechanism.md`, `debugger-ui.md` | 🟢 Real breakpoints (improvement); 🟡 step-in/out not distinct |
| Hamster language — Band 1 | `hamster-language.md` | 🟡 ~70–75% complete |
| Hamster language — Band 2 (OO) | `hamster-language.md` | 🟢 Class model, generics (erased), exceptions incl. `finally`, `instanceof` |
| Hamster language — Band 3 (concurrency) | `hamster-language.md` | 🟢 Cooperative threads, monitors, `wait`/`notify`; ⚪ scheduling deviations documented below |
| Alternate frontends / 3D / i18n | `alternate-frontends.md`, `platform-concerns.md` | 🟢 Correctly out of scope, no confusing remnants |

## Detailed Findings

### 1. Language: Lexer (`lang/hamster-lexer.js`)
- 🟢 Control-flow keywords `switch`, `case`, `default`, `break`, `try`, `catch`, `finally`, and `throw` are recognized, as are `instanceof` and `synchronized`.
- 🟢 `long` literals (`0L`) are accepted. ⚪ Deviation: they are JavaScript numbers, exact only up to 2^53, with no 64-bit overflow semantics.
- 🟢 Compound-assignment operators `+=`, `-=` are recognized.
- 🟡 Identifier grammar excludes `$` (spec allows `[A-Za-z_$][A-Za-z0-9_$]*`).
- 🟡 Unknown string escapes are silently accepted (drops backslash) instead of raising a lexical error.
- 🟢 Core Band-1 keywords, comments, numeric/boolean/null/string literals, common operators all present.

### 2. Language: Parser (`lang/hamster-parser.js`)
- 🟢 Full Band 1 statement/expression grammar: `if/else`, `while`, `do/while`, `for` (desugared), `return`, blocks, calls, member access, indexing, postfix `++`/`--`.
- 🟢 Compatibility mode retains classes and interfaces with modifiers, inheritance, implemented interfaces, fields, constructors, and methods.
- 🟢 `switch/case/default/break` and `try/catch/finally/throw` (several `catch` clauses, optional `finally`) parse to dedicated AST nodes.
- 🟢 `instanceof` parses at relational precedence, including qualified, generic, and array types.
- 🟢 Generics: type arguments (nested, wildcards, diamond after `new`) and type parameters on classes, interfaces, and methods parse and are erased in the AST.
- 🟢 `synchronized` parses as a method modifier and as a `synchronized (lock) { … }` statement.
- 🟢 Array initializers (`{ … }`, nested, trailing comma) parse in declarations and after `new T[]`.
- 🟢 Qualified type names (`java.util.Calendar c`, `new pkg.Type()`) resolve by simple name, since packages are not modelled.
- 🟢 Several variables in one local, global, or `for` declaration.
- 🟢 Class literals `Foo.class` (one canonical value per class) and `getClass()`.
- 🟢 for-each loops over arrays. 🟡 Collections are not iterable until Java collections exist; the error names the type.
- 🟢 Varargs parameters, with Java's exact-arity-first overload choice and array pass-through.
- 🟢 Constant-only enums: `values()`, `valueOf()`, `name()`, `ordinal()`, `compareTo()`, unqualified `switch` labels. 🟡 Enums with constructors, constant bodies, or members are a tagged known gap (`enum-body`); no sample uses them.
- 🟢 Casts `(int) expr` / `(Type) expr` parse; `(int)` truncates like Java, and reference casts to known classes/interfaces throw a catchable `ClassCastException` on mismatch.
- 🟢 Prefix and postfix `++`/`--` are parsed.
- 🟢 Array creation (`new int[n]`, `new boolean[r][c]`, `new Type[n][]`) supports primitive element types and multiple dimensions, with Java default element values.
- 🟡 Unsupported top-level syntax can be silently skipped in non-strict compatibility mode rather than reported as an error.

### 3. Language: Runner/Interpreter (`lang/hamster-runner.js`)
- 🟢 Binary `+` performs numeric addition unless either operand is a string, matching Java string concatenation semantics.
- 🟢 Postfix `++`/`--` supports identifiers, array elements, and object members.
- 🟢 User-defined objects support inherited fields, constructor chaining, virtual method dispatch, and `this`/`super` access.
- 🟢 `try/catch/throw` supports typed catches, user-thrown values and objects, and the documented German/English `HamsterException` hierarchy. Failed `vor`/`nimm`/`gib` calls surface as catchable `WallInFrontException`/`TileEmptyException`/`MouthEmptyException`; uncaught exceptions remain fatal.
- 🟢 `switch` uses Java-style matching and fall-through; `break` exits the nearest loop or switch.
- 🟢 German and English Hamster API names dispatch consistently for top-level and object calls, including console input/output and property getters.
- 🟢 `Territorium`/`Territory` static queries and German/English direction and color constants are available.
- 🟢 Multiple `catch` clauses match in order. `finally` runs on every exit path, and a `return`/`throw` inside it overrides the earlier outcome. `instanceof` uses the same class/interface hierarchy as casts and `catch` and is `false` for `null`.
- 🟢 Array initializers evaluate their elements left to right; literal-only global initializers are constant-folded.
- 🟢 `synchronized` performs real mutual exclusion, per object and per class literal, re-entrant, and released on every exit path including an exception unwinding out of the section.
- 🟢 Cooperative concurrency: a started hamster becomes its own thread, matching the reference, where `IHamster extends Thread` and every hamster command is a scheduling point (`IHamster.java:33, 87-142`). Supported: `start`, `run`, `join`, `sleep`, `interrupt`, `isInterrupted`, `Thread.interrupted`, `isAlive`, `setDaemon`/`isDaemon`, `setPriority`/`getPriority`, `setName`/`getName`, `stop`, `Thread.currentThread`, `Thread.yield`, `wait`/`notify`/`notifyAll`, and `InterruptedException`.
- 🟡 Java library classes (`ArrayList`, `java.util.concurrent.*`, `java.util.Timer`, …) still fail with a message naming the class. The course material has students build a `Semaphor` from `wait`/`notify`, so the library versions are a convenience rather than the lesson.
- 🟢 Program-type markers select imperative, object-oriented, or reusable-class parsing semantics; unmarked files default to imperative as in the reference implementation.
- ⚪ Hardcoded loop-iteration (~100k) and recursion-depth (~256) guards not in the original spec — reasonable safety net, but undocumented for users. The loop guard is now a *per-thread progress budget*: it resets on every hamster instruction and every blocking operation, so `while (true) { … vor(); }` — the normal shape of a concurrent hamster — runs until the user stops it, while a loop that makes no observable progress is still caught.

### 4. Simulation Rendering (`hamsterPanel.ts` webview)
- 🟢 Simulation zoom controls use the original 32px default, ±4px steps, and 4px minimum.
- 🟢 Direction sprites are recolored and cached per hamster color, preserving their black details while supporting all ten German/English `Hamster` color constants.
- 🟢 `.ter` loading preserves multiple direction markers as a VS Code extension. Legacy files keep the reference loader's last-marker default, while an optional trailing `@default x y` line preserves default-hamster identity across editor round trips and is ignored by the reference loader.
- 🟢 Terrain/corn/wall model (width/height/walls/corn grids, default hamster id -1) matches `domain-model.md` semantics.

### 5. Terrain Editor (`terrainEditor.ts`)
- 🟢 The default hamster's mouth/corn inventory can be edited and is preserved in the terrain file.
- 🟢 `setWall()` prevents placing a wall under any hamster and clears the cell's corn count when a wall is placed, matching the original terrain-editing invariants.
- 🟡 Width/height inputs don't refresh to reflect a loaded `.ter` file's actual dimensions (canvas resizes correctly; text inputs stay stale).
- 🟡 Malformed/short `.ter` files silently fall back to a default 10×8 terrain with no user-visible error.
- 🟢 On-disk `.ter` format (dimensions, wall/corn grid, corn-count lines, mouth count) is compatible with the original — existing original `.ter` files should load correctly for the common case.

### 6. Console / Terminal I/O
- 🟢 `schreib`/output routed to a webview log panel — a reasonable, simpler substitute for the original's threaded `Console`.
- 🟢 `liesZahl`/`liesZeichenkette` and their English aliases use a cooperative pause with an inline webview prompt, then resume the pending Run, Step, or debugger operation.

### 7. Compiler Pipeline Equivalent
- 🟡 `hamster.compile` command is a **strict parse/validate** (`requireMain: true, strict: true`), not a real compilation step — reasonable given there's no bytecode target, but should be labeled/documented as "Check" rather than "Compile" to avoid confusing users familiar with the original.
- 🟢 Program-type markers select validation behavior consistently across diagnostics, compile, run, and debug paths; class files do not require `main()` and cannot be run directly.
- 🟢 Live diagnostics (`diagnostics.ts`) recover after independent lexer/parser errors and underline each offending token using its exact source length.
- 🟢 The extension host statically imports and bundles the lexer/parser module; raw source loading is limited to the nonce-protected simulator webview script.

### 8. Debugger (`hamsterDebugSession.ts` + debug bridge in `hamsterPanel.ts`)
- 🟢 **Real, persistent, user-settable breakpoints** — a genuine improvement over the original app, which had none (`debugger-ui.md`).
- 🟢 Stack trace / scopes / variables implemented via interpreter-maintained frames — functions even without a JDI equivalent.
- 🟡 `next`, `stepIn`, and `stepOut` all currently perform the *same* single AST-statement advance — no call-depth-aware step-out/step-over distinction.
- 🟢 Breakpoints are validated against parsed executable statement locations, moved to the next valid line, and honored during both continue and single-step operations.
- 🟢 `evaluate` (DAP hover/watch/debug console) parses and evaluates expressions in the selected stack frame.
- 🟡 No object/array expansion in the variables view (`variablesReference` always 0).
- 🟢 Each live hamster is its own DAP thread with its own call stack, scopes, and variables; `thread` started/exited events track hamsters as they start and finish, and a blocked hamster reports what it is waiting for. Frame ids and variable references are namespaced by thread id.
- ⚪ Deviation: a breakpoint stops *every* thread (`allThreadsStopped`), and `supportsSingleThreadExecutionRequests` is deliberately not advertised. Because execution is cooperative only one hamster is ever mid-action, so stopping everything yields a consistent snapshot. Stepping still advances the thread the user selected.

### 9. Explicitly Out of Scope (confirmed clean)
No confusing partial/stub remnants found for: Scheme/JavaScript/Python/Ruby/Prolog consoles, Scratch/FSM/Flowchart visual editors, LEGO integration, 3D/OpenGL view, or Java-style multi-locale i18n bundles. Per `alternate-frontends.md`/`platform-concerns.md`, these are reasonable scope cuts for this port.

## Prioritization for Fixes
1. **P0 — correctness bugs likely to confuse users immediately:** postfix `++`/`--` restricted to identifiers, wall-under-hamster placement.
2. **P1 — core language gaps blocking Band 2 curriculum content:** real classes/inheritance/interfaces/constructors, `try/catch/throw` + exception hierarchy, `switch/case/break`, English API aliases, `+=`/`-=`, prefix `++`/`--`.
3. **P2 — fidelity/UX gaps:** per-hamster color sprites, multi-hamster `.ter` loading, program-type marker handling, step-in/out distinction, terrain editor mouth-count UI.
4. **P3 — polish/maintainability:** `new Function()` replacement, multi-error diagnostics, expression evaluation in debugger.

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
