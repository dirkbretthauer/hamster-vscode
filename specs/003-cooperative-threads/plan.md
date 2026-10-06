# Implementation Plan: Cooperative Hamster Threads

**Branch**: `003-cooperative-threads` | **Date**: 2026-10-06 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/003-cooperative-threads/spec.md`

## Summary

Make a started hamster its own cooperatively-scheduled thread, so the Band 3 chapter 10–12 teaching
programs run, can be observed, and can be debugged. In the reference simulator a hamster literally
*is* a thread (`IHamster extends Thread`), and every hamster command is a scheduling point; this
port reproduces that shape without real parallelism.

The technical approach rests on one finding, validated by a prototype before planning: the runner's
state splits cleanly into **nine program-wide fields and five per-thread registers**, and no code
holds a reference to those registers across a `yield`. So N threads are N plain state objects that
share the program maps by reference and own their own `scopes`/`frames`/`generator`/`finished`/
`lastInstruction` — **the existing generator bodies need no changes at all**. A new
`lang/hamster-scheduler.js` picks which thread to advance, owns monitors and the simulation clock,
and replaces the three direct `executeRunnerStep` call sites. Thread and monitor operations are
intercepted in the runner (they must block, which means yielding) rather than in the runtime
adapter, which is synchronous.

## Technical Context

**Language/Version**: TypeScript 5.x (`src/`, extension host) + plain JavaScript ES modules
(`lang/`, `src/webview/`, no build step of their own)

**Primary Dependencies**: VS Code API ^1.85, webpack (bundles `dist/webview/*.js`), Debug Adapter
Protocol (inline implementation, no external DAP library)

**Storage**: Files only — `.ham` programs and `.ter` terrains via `vscode.workspace.fs`. No new
persistence.

**Testing**: `scripts/language-smoke.cjs` (lexer/parser/runner, loads `lang/*.js` as base64 data
URLs) + `node --test` over `test/*.test.{mjs,cjs}`; `scripts/conformance.cjs` for the external
950-program corpus. No automated webview/DAP suite — manual F5 verification is the safety net.

**Target Platform**: Desktop VS Code (`main`, Node) **and** vscode.dev (`browser`, web worker).
Both entry points must keep working.

**Project Type**: VS Code extension with an embedded language toolchain (lexer/parser/interpreter)
and two webviews.

**Performance Goals**: No perceived per-action slowdown with ten concurrent hamsters versus one at
the same speed setting (SC-004). Scheduler overhead per step must stay O(number of runnable
threads), which at the corpus's scale (≤ 6 hamsters) is negligible. Existing batching
(`DEBUG_STEP_BATCH_SIZE = 100`, `DEBUG_STEP_TIME_SLICE_MS = 8`) stays intact.

**Constraints**: Extension host must never block; cooperative only, never truly parallel; the varied
interleaving required by FR-010 makes concurrent runs non-reproducible, so tests must assert
interleaving-independent invariants; deadlock must be reported within 2 s (SC-005).

**Scale/Scope**: ~2 000-line runner, ~430-line simulator bootstrap, ~372-line webview debugger,
~525-line DAP session. 158 corpus programs use concurrency; **95** are reachable by this feature
(see Spec Issues). One new `lang/` module, ~10 touched files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Initial | Post-design |
|---|---|---|---|
| **I. Reference Fidelity** | Semantics traced to the Java sources, not the prose spec | ✅ `IHamster.java:33, 49-56, 76-85, 87-142` read; scheduling points and error isolation taken from it (research R1) | ✅ Deviations enumerated and assigned to FR-038: varied-but-not-reference scheduling, priority weighting, simulation-clock `sleep`, no `$_dibo_p_intern$` marker |
| | `.ter` files stay loadable by the reference | ✅ No terrain change | ✅ Unchanged |
| | Gap list updated in the same change | ⚠️ Planned | ✅ `.agents/skills/hamster-language/SKILL.md:154-155` + `spec/vscode-port-status.md:28, 42, 84, 85, 112` scheduled as explicit tasks |
| **II. Language Pipeline Integrity** | `lang/*.js` stay ES modules, no CommonJS | ✅ New `lang/hamster-scheduler.js` is an ES module | ✅ |
| | New AST nodes registered in parser **and** runner | ✅ **No new AST nodes** — `synchronized` already lexes (`hamster-lexer.js:36`) and parses (`:685-686, :856-865, :2141`) | ✅ Confirmed: parse-only conformance must show no change |
| | Runner delegates with `yield*` | ✅ Blocking scheduler operations are generator functions reached by `yield*` | ✅ Contract fixes this (scheduler-api.md) |
| | Typed errors with line/column | ✅ | ✅ Error table in ham-thread-api.md |
| | New keywords reflected in the grammar | ✅ None added | ✅ |
| **III. Webview Security & Typed Protocol** | Nonce + CSP preserved | ✅ No new script tags | ✅ |
| | Discriminated union + guards on both ends | ⚠️ New `dbg:*` types needed | ✅ debug-protocol.md specifies each type, its guard case, and the silent-drop hazard at `hamsterPanel.ts:144-151` |
| **IV. Web-Compatible Host** | No Node-only APIs | ✅ Scheduler is pure JS | ✅ Contract forbids DOM/`vscode`/engine access from the scheduler |
| | Everything disposed | ⚠️ One timer today (`runTimerId`), must not become N | ✅ `step()` advances one thread per call, so the single timer chain is kept |
| | `activate()` stays cheap | ✅ Unaffected | ✅ |
| | Commands namespaced `hamster.*` | ✅ No new commands | ✅ |
| **V. Test-Backed Changes** | `npm test` + `npm run compile` pass | ⚠️ Planned | ✅ Scheduler lives in `lang/` precisely so the fast suites can cover it headlessly |
| | Language changes covered in the smoke suite | ⚠️ Planned | ✅ Plus new `test/scheduler.test.mjs`; the 3 pinned assertions at `test/simulatorRuntime.test.mjs:56-69` are replaced, not deleted |
| | Conformance not regressed | ✅ Parse-only, no syntax change ⇒ must be identical | ✅ |
| | Manual F5 + Web host verification | ⚠️ Planned | ✅ quickstart.md scenarios 1–8 |
| **VI. Simplicity & Focused Changes** | One logical change per commit | ⚠️ Large feature | ✅ Sliced by user story (US1 → US5), each independently shippable |
| | No new `any` in TS | ✅ | ✅ Protocol additions are concrete types |
| | No abstraction for a single use | ✅ | ✅ Scheduler has two real consumers (run loop + debugger); see Complexity Tracking |

**Gate result: PASS** (initial and post-design). The one justified complexity addition is recorded
in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/003-cooperative-threads/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 output — R1..R12
├── data-model.md        # Phase 1 output — ProgramState/ThreadState/Thread/Monitor/Scheduler
├── quickstart.md        # Phase 1 output — 8 validation scenarios
├── contracts/           # Phase 1 output
│   ├── ham-thread-api.md    # the .ham language surface
│   ├── debug-protocol.md    # host <-> webview dbg:* changes
│   └── scheduler-api.md     # lang/hamster-scheduler.js module API
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
lang/
├── hamster-lexer.js            # unchanged
├── hamster-parser.js           # unchanged (synchronized already parses)
├── hamster-runner.js           # MODIFIED: split program vs thread state; intercept
│                               #   thread/monitor ops; per-thread loop guard; drop dead
│                               #   `state.stack`; add InterruptedException supertype
├── hamster-scheduler.js        # NEW: threads, monitors, simulation clock, selection
└── hamster-terrain.js          # unchanged

src/
├── webviewProtocol.ts          # MODIFIED: threadId fields, dbg:threads/threadStarted/threadExited
├── hamsterDebugSession.ts      # MODIFIED: real thread list, thread events, threadId plumbing
├── hamsterPanel.ts             # unchanged (guards gate the new types automatically)
└── webview/
    ├── langBundleEntry.js      # MODIFIED: re-export the scheduler
    └── simulator/
        ├── index.js            # MODIFIED: run loop drives the scheduler; per-thread input
        ├── runtime.js          # MODIFIED: remove THREAD_METHOD_NAMES/unsupportedThreadError
        ├── engine.js           # MODIFIED: per-hamster terminal input (drop the single slot)
        ├── debugger.js         # MODIFIED: thread-aware stacks/scopes/stepping, id namespacing
        └── renderer.js         # MODIFIED: mark the hamster that acted last (FR-032)

scripts/
├── language-smoke.cjs          # MODIFIED: scheduler/monitor/interleaving coverage
└── concurrency-corpus.cjs      # NEW: SC-001 measurement over the reference corpus

test/
├── scheduler.test.mjs          # NEW: selection, monitors, deadlock, state machine
├── simulatorRuntime.test.mjs   # MODIFIED: replace the 3 thread-unsupported assertions
└── webviewProtocol.test.cjs    # MODIFIED: guard cases for the new message types

spec/vscode-port-status.md      # MODIFIED: lines 28, 42, 84, 85, 112
.agents/skills/hamster-language/SKILL.md  # MODIFIED: gap list lines 154-155
CHANGELOG.md                    # MODIFIED: user-visible feature
```

**Structure Decision**: The existing layout already separates the language toolchain (`lang/`),
the webview runtimes (`src/webview/`), and the extension host (`src/`). The scheduler belongs in
`lang/` because it is language-execution semantics with two consumers, and because only code under
`lang/` is reachable from the fast headless suites — which matters when there is no automated
webview or DAP test suite. No new top-level directory is introduced.

## Implementation Slices

Each slice is independently shippable and maps to one user story.

| Slice | Story | Scope | Proves |
|---|---|---|---|
| **1** | US1 (P1) | `hamster-scheduler.js` with program/thread state split, `start`/`run`, non-daemon join-at-exit, FR-008 error isolation; run loop drives the scheduler; renderer marks the acting hamster | Two hamsters interleave; SC-006 |
| **2** | US2 (P2) | Monitors: `synchronized` statement + method modifier, re-entrancy, release on unwind, entry queues | SC-002 protected/unprotected difference |
| **3** | US3 (P3) | `wait`/`notify`/`notifyAll`, wait sets, depth save/restore, ownership errors, deadlock detection | SC-003 semaphore/producer-consumer/philosophers |
| **4** | US4 (P4) | `join`, `sleep`, `interrupt`/`isInterrupted`/`interrupted`, `setDaemon`, `isAlive`, name, priority, `stop`, `Thread.currentThread`, `yield`, `InterruptedException` | Daemon/join/interrupt chapter 10.3–10.5 |
| **5** | US5 (P5) | Protocol additions, DAP thread list + thread events, frame/varRef namespacing, per-thread stepping, blocked-thread inspection | SC-008, SC-009 |

Cross-cutting, landed with slice 1: per-thread loop guard (FR-014, research R8), per-thread
terminal input (research R9), documentation updates (FR-038).

## Spec Issues Found During Planning

Raised here rather than silently absorbed; each needs a spec edit before `/speckit-tasks`.

1. **SC-001 is not achievable as written and contradicts the spec's own Assumptions.** It demands
   all 159 concurrency programs run "with none failing because a concurrency feature is
   unsupported", while the Assumptions place "executor services, concurrency utilities" out of
   scope. But `java.util.concurrent.Semaphore` *is* a concurrency feature. Measured breakdown
   (research R11): of **158** such programs (not 159 — the extra match is a comment in
   `band 2/kapitel 16/abschnitt 3/graphik.ham`), **95** need nothing beyond threads and monitors,
   49 additionally need `util.AllroundHamster` (a pre-existing import concern, not concurrency),
   9 need `java.util.concurrent`/`Timer`, and 5 need collection classes.
   **Recommended rewording**: target the 95, report the other 63 by category, and state that up to
   144 become reachable once `util.AllroundHamster` resolution is handled separately.

2. **SC-004 is not objectively measurable as written** ("without the user perceiving the simulation
   as slower"). Suggest a concrete proxy: scheduler overhead per step stays under a fixed budget,
   and ten hamsters at the same speed setting complete a fixed workload within 110 % of the
   single-hamster wall-clock time.

3. **FR-012 and the reference disagree about what priority means.** The spec says higher priority
   is chosen more often; the reference's formula (`IHamster.java:80`) actually gives
   *higher*-priority threads more no-op yield points. The plan implements the spec's intuitive
   meaning and books the difference as a documented deviation (FR-038) — flagging it because it is
   a knowing departure from principle I.

None of these block Phase 2; slices 1–5 are unaffected by the wording.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| New module `lang/hamster-scheduler.js` (principle VI: no abstraction for a single use) | Two independent consumers already exist — the simulator run loop (`index.js:151`) and the debugger (`debugger.js:150, :227`) — and a third, `scripts/language-smoke.cjs`, must drive it headlessly | Inlining the scheduler into `hamster-runner.js` would push UI-facing concerns (thread list, deadlock report, simulation clock) into the interpreter and make the 2 000-line file harder to reason about. Putting it in `src/webview/simulator/` would make it untestable by the fast suites and force duplication across the two drive loops. |
| Non-reproducible concurrent runs (tension with principle V's test-backed posture) | Required by the answered clarification on FR-010 — varied interleaving is what makes the chapter 11 exercises teach anything | Deterministic scheduling was the rejected option; it would make unprotected programs always produce the right answer. Mitigated by injecting the random source so tests stay deterministic while shipped behaviour stays varied, and by asserting interleaving-independent invariants. |
