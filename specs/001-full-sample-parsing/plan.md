# Implementation Plan: Full Sample-Program Parsing

**Branch**: `001-full-sample-parsing` | **Date**: 2026-10-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-full-sample-parsing/spec.md`

## Summary

Make every in-scope Java-like sample program from the reference simulator parse (808 → ~910 of 920). The parser
gains support for six constructs: `synchronized` (modifier and block), generics (type arguments, type parameters,
wildcards; erased in the AST), `try` with multiple `catch` and `finally`, `instanceof`, and array initializers.
The runner gets Java semantics for each construct that has runtime meaning. The six out-of-scope constructs
(FR-017) get targeted "not supported" errors tagged with an `unsupportedConstruct` code. The conformance script
uses those codes to report known gaps separately, and can gate on a 100% in-scope pass rate. New smoke tests per
construct validate the work inside the repo; the corpus gate validates it against the reference samples.

## Technical Context

**Language/Version**: TypeScript 5.x (extension host, `src/*.ts`); plain JavaScript ES modules for `lang/` and
`src/webview/` (no own build step)

**Primary Dependencies**: VS Code API ^1.85; webpack 5 + ts-loader for bundling; no runtime npm dependencies

**Storage**: N/A (reads `.ham`/`.ter` files through `vscode.workspace.fs`; the conformance script reads the corpus
from disk)

**Testing**: `scripts/language-smoke.cjs` (assert-based smoke suite) and `node --test` unit suites in `test/`, both
run by `npm test`; `scripts/conformance.cjs` as the corpus gate (not part of `npm test`)

**Target Platform**: VS Code desktop and web (vscode.dev) extension hosts; webviews in VS Code's Chromium

**Project Type**: VS Code extension with an embedded language toolchain (lexer → parser → generator-based
interpreter)

**Performance Goals**: parsing stays linear in the number of tokens. The type-argument scanner is bounded by the
matching `>`, with no unbounded backtracking. `npm test` stays under 10 s (SC-004).

**Constraints**: no Node-only APIs in `lang/` or `src/webview/` (browser entry point); the runner must keep its
`yield*` cooperative stepping; the AST stays plain objects; existing accepted programs must not regress (FR-016)

**Scale/Scope**: about 920 Java-like corpus programs; 6 constructs in scope, 6 explicitly out of scope; touches
about 7 source files and 2 scripts

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Pre-design | Post-design |
|---|---|---|---|
| I. Reference Fidelity | Semantics match the Java sources and the JLS; deviations documented; gap list synced | ✅ semantics per JLS (finally overrides, ordered catch, `instanceof` null → false) | ✅ single-thread "no-op locking" for `synchronized` is documented as a deviation in `spec/vscode-port-status.md`; skill gap list updated with the six known gaps (D7) |
| II. Language Pipeline Integrity | ES modules; new nodes in `ASTNodeType` and the runner; `yield*`; located errors; grammar updated | ✅ planned | ✅ `SynchronizedStatement`, `InstanceofExpression`, `ArrayInitializer`, `CatchClause` each get a runner case; `try` outcomes captured without a JS `finally` (D4); tmLanguage keywords added (D10) |
| III. Webview Security & Typed Protocol | No CSP or protocol regressions | ✅ no protocol changes | ✅ unchanged |
| IV. Web-Compatible Host | No Node-only APIs in shared paths; no blocking work | ✅ | ✅ only `lang/` and `src/webview/simulator/runtime.js` change; pure JS |
| V. Test-Backed Changes | `npm test` + `npm run compile`; smoke coverage per construct; conformance must not drop; manual F5 | ✅ planned | ✅ D9 plus quickstart steps 1–5; the conformance gate becomes stricter (`--min-pass-rate=1`) |
| VI. Simplicity & Focused Changes | One logical change per commit; no new `any`; no speculative abstraction | ✅ | ✅ one commit per construct (see Delivery order); erasure instead of a type model (D2); one shared initializer helper (D6) |
| Workflow | Feature branch and PR; docs synced | ⚠️ the working copy is on `main` | ✅ create branch `001-full-sample-parsing` before the first commit; docs are listed below |

No violations need justification. Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/001-full-sample-parsing/
├── plan.md              # This file
├── research.md          # Phase 0: corpus survey + decisions D1–D10
├── data-model.md        # Phase 1: AST changes, try outcome model, error codes, conformance categories
├── quickstart.md        # Phase 1: validation guide
├── contracts/
│   ├── ast-nodes.md     # grammar additions + node shapes + error shape
│   └── conformance-cli.md
├── checklists/
│   └── requirements.md  # spec quality checklist (from /speckit-specify)
└── tasks.md             # Phase 2 (/speckit-tasks; not created here)
```

### Source Code (repository root)

```text
lang/
├── hamster-lexer.js       # keywords synchronized/finally/instanceof; long-literal known-gap error
├── hamster-parser.js      # type-argument scanner, type parameters, synchronized, try/catch*/finally,
│                          # instanceof, array initializers, known-gap errors, collectExecutableLines
└── hamster-runner.js      # SynchronizedStatement, try outcome model, InstanceofExpression,
                           # ArrayInitializer (+ global constant folding)
src/
├── diagnostics.ts         # unchanged (error shape is backward compatible); verify only
└── webview/simulator/
    └── runtime.js         # FR-014 messages for library classes and thread methods
syntaxes/
└── hamster.tmLanguage.json  # new keywords
scripts/
├── language-smoke.cjs     # parse + execution tests per construct
└── conformance.cjs        # known-gap classification, gate on in-scope rate
.agents/skills/hamster-language/SKILL.md   # gap list
spec/vscode-port-status.md                 # conformance status + synchronized deviation
```

**Structure Decision**: the existing single-project layout. All language work stays in `lang/`, per the
constitution's layer boundaries. The only webview change is the runtime adapter's error messages.

## Delivery order (one logical change per commit, Principle VI)

1. **Generics**: type-argument scanner and erasure in all type positions; type parameters on
   classes, interfaces, and methods (D1, D2).
2. **`synchronized`**: modifier, block statement, and runner case (D3).
3. **`try`**: multiple `catch` and `finally`, the AST shape change, and the runner outcome model (D4).
4. **`instanceof`**: parser and runner, reusing the cast hierarchy helpers (D5).
5. **Array initializers**: parser helper, `new T[] {…}`, runner, and global folding (D6).
6. **Known-gap errors and the conformance known-gap report/gate** (D7, D9).
7. **Runtime messages for library classes and threads** (D8).
8. **Syntax highlighting and docs** (D10, gap list, port-status). Docs may instead ride along with each construct's
   commit.

Each commit adds its own smoke tests and must keep `npm test` green. The conformance pass rate is checked after
each commit and must never decrease.

## Complexity Tracking

No constitution violations to justify.
