---

description: "Task list for Cooperative Hamster Threads"
---

# Tasks: Cooperative Hamster Threads

**Input**: Design documents from `/specs/003-cooperative-threads/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Test tasks are included because constitution principle V *requires* them — "New or
changed language behavior MUST add or update coverage in `scripts/language-smoke.cjs`; new pure
helpers … MUST get `test/` unit coverage." They are not optional for this feature.

**Organization**: Tasks are grouped by user story so each story can be implemented, tested, and
demonstrated independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US5)
- Exact file paths are given in every task

## Path Conventions

This is a VS Code extension with an embedded language toolchain (see plan.md → Structure
Decision). Real directories:

- `lang/` — language toolchain, plain ES modules, no build step of their own
- `src/` — TypeScript extension host
- `src/webview/simulator/` — simulator webview runtime, plain ES modules
- `scripts/`, `test/` — fast headless suites
- `specs/003-cooperative-threads/` — this feature's design docs

---

## Phase 1: Setup (Spec Corrections & Scaffolding)

**Purpose**: Make the success criteria measurable before implementation starts, and put the new
module/test scaffolding in place.

- [ ] T001 [P] Correct SC-001 in `specs/003-cooperative-threads/spec.md` to the measured targets from research.md R11: of **158** concurrency-using corpus programs (not 159 — the extra match is a `synchronized` inside a comment in `band 2/kapitel 16/abschnitt 3/graphik.ham`), **95 need nothing beyond threads and monitors** and are this feature's target; 49 additionally need `util.AllroundHamster` (a pre-existing import gap), 9 need `java.util.concurrent`/`Timer`, 5 need collection classes. State that up to 144 become reachable once `util.AllroundHamster` resolution is handled separately.
- [ ] T002 [P] Replace the unmeasurable SC-004 in `specs/003-cooperative-threads/spec.md` ("without the user perceiving the simulation as slower") with a concrete proxy: ten concurrently acting hamsters complete a fixed workload within 110% of the single-hamster wall-clock time at the same speed setting.
- [ ] T003 [P] Add a note to FR-012 in `specs/003-cooperative-threads/spec.md` recording that the reference's priority formula (`IHamster.java:80`, `random() * (2 + MAX_PRIORITY - getPriority())`) gives *higher*-priority threads more no-op yield points, the opposite of the intuitive meaning this feature implements — a knowing deviation to be written up under FR-038.
- [ ] T004 Create `lang/hamster-scheduler.js` as an ES module (`export`/`import`, **never** CommonJS — constitution principle II) exporting `createScheduler(programState, options)` per `contracts/scheduler-api.md`, with named constants `DEFAULT_PRIORITY = 5`, `MIN_PRIORITY = 1`, `MAX_PRIORITY = 10`, `DEFAULT_MAX_THREADS`, `STEPS_PER_MILLISECOND`, and the `ThreadStatus` frozen enum (`NEW`, `RUNNABLE`, `RUNNING`, `BLOCKED`, `WAITING`, `TIMED_WAITING`, `JOINING`, `TERMINATED`). Stub bodies only.
- [ ] T005 [P] Re-export the scheduler globals from `src/webview/langBundleEntry.js` so both webviews reach them through the bundled `dist/webview/hamster-lang.js` (same pattern as the existing `Object.assign(window, lexer, parser, runner, terrain)` at line 17).
- [ ] T006 [P] Create `test/scheduler.test.mjs` with the base64 data-URL module loader harness, copying the `moduleUrl` / `readWebviewModule` pattern from `test/simulatorRuntime.test.mjs:12-43`, using `import { test } from 'node:test'` + `import assert from 'node:assert/strict'` and flat top-level `test(...)` calls (no `describe`).
- [ ] T007 [P] Create `scripts/concurrency-corpus.cjs` that walks the reference corpus (resolve `referenceDir` exactly as `scripts/conformance.cjs:45` does: positional arg → `HAMSTER_REFERENCE_DIR` → `DEFAULT_REFERENCE_DIR`; read files as `latin1`), classifies each concurrency-using program into the four R11 buckets, and prints per-bucket counts plus pass/fail for the 95-program target.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The program-state / thread-state split and the scheduler core. Everything else
depends on this.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T008 In `lang/hamster-runner.js`, split `createRunnerState` into `createProgramState(ast, runtime, classModules)` holding the nine shared fields (`ast`, `functions`, `classes`, `staticFields`, `staticInitializers`, `staticInitializersByClass`, `classInitialization`, `enumConstants`, `classLiterals`, `runtime`) plus new `globalScope`, `monitors` (a `Map`, **not** a `WeakMap`, so the deadlock reporter can enumerate it — research R6) and `scheduler`; and `createThreadState(programState, generator)` holding those by reference plus the five private registers `scopes`, `frames`, `generator`, `finished`, `lastInstruction`. Export both.
- [ ] T009 In `lang/hamster-runner.js`, keep `createRunnerState(ast, runtime, classModules)` as a thin backward-compatible wrapper returning the main thread's state, so every existing caller (`src/webview/simulator/index.js:121`, `scripts/language-smoke.cjs:81`, `test/*`) and the single-threaded path keep working unchanged.
- [ ] T010 In `lang/hamster-runner.js` `createThreadState`, set `scopes[0]` to the **same** `programState.globalScope` Map object (not a copy) so globals are shared, and add an invariant check; forking it silently splits the globals (prototype-asserted in research R2).
- [ ] T011 Remove the dead `state.stack` field from `lang/hamster-runner.js` (declared around line 200 as "Legacy stack field kept for backward-compatible state inspection", never read or written anywhere — research R12).
- [ ] T012 Replace the two hard-coded loop guards in `lang/hamster-runner.js:489-491` and `:500-502` (`if (++guard > 100000) throw new Error('Loop iteration limit exceeded')`) with a per-thread progress budget held on the thread state, using a named constant instead of the literal `100000`, and reset the counter whenever the thread performs a hamster action or blocks — so `while (true)` in a hamster's `run()` is legal (FR-014, research R8) while a true spin loop is still caught.
- [ ] T013 Implement the `Thread` record and `ThreadStatus` state machine in `lang/hamster-scheduler.js` per data-model.md §3: fields `id` (monotonic from 1, thread 1 is always `main`), `name`, `state`, `hamster`, `status`, `daemon` (default `false`), `priority` (**1–10, default 5**), `interrupted`, `blockedOn`, `wakeAtStep`, `monitorsHeld`, `progressCounter`, `pendingInput`, `exitError`. Enforce: `TERMINATED` is terminal; `monitorsHeld` must be empty after that transition.
- [ ] T014 Implement the scheduler core in `lang/hamster-scheduler.js`: `step(opts)` returning the `StepResult` shape from `contracts/scheduler-api.md` (`status`, `thread`, `instruction`, `events`, `report`), weighted `pick()` over runnable threads using `weight = priority` so a priority-10 thread is picked ten times as often as priority-1 **and no runnable thread ever has weight 0** (FR-012, research R5), the injectable `random` source defaulting to `Math.random`, the monotonic `step` counter used as the simulation clock, plus `threads()`, `liveThreads()`, `current()`, `threadById()`, `isFinished()` (every non-daemon thread `TERMINATED`) and `reset()`.
- [ ] T015 Enforce the `contracts/scheduler-api.md` contract that `step()` advances **at most one thread by at most one runner step**, forwarding `opts.granularity` unchanged to that thread, so the existing batching (`DEBUG_STEP_BATCH_SIZE = 100`, `DEBUG_STEP_TIME_SLICE_MS = 8` at `src/webview/simulator/debugger.js:10-11`) and the speed-slider pacing keep working.
- [ ] T016 [P] Add smoke coverage in `scripts/language-smoke.cjs` proving the state split changed nothing for single-threaded programs: existing globals/statics assertions still pass through the `createRunnerState` wrapper, and `state.scopes[0]` still holds globals.
- [ ] T017 [P] Add unit tests in `test/scheduler.test.mjs` for the `ThreadStatus` transitions and for weighted selection with an injected deterministic `random`, asserting no runnable thread is ever starved.

**Checkpoint**: Foundation ready — user story implementation can begin.

---

## Phase 3: User Story 1 - Several hamsters act at the same time (Priority: P1) 🎯 MVP

**Goal**: A program that creates and starts two or more hamsters runs them interleaved over one
terrain, and finishes only when every non-daemon hamster has finished.

**Independent Test**: Run quickstart.md Scenario 1 — two grain-eating hamsters on one terrain both
move, visibly alternating; the simulator marks whichever acted last; the program reports Finished
only after both stop; two runs show different interleavings.

- [ ] T018 [US1] Implement `scheduler.spawn(hamsterObject, runMethod)` in `lang/hamster-scheduler.js`: allocate the next thread id, build its `ThreadState` via `createThreadState`, set status `NEW` → `RUNNABLE`, and enforce the documented `maxThreads` cap with the error `Too many hamster threads (limit <n>)` from `contracts/ham-thread-api.md`.
- [ ] T019 [US1] Intercept `start()` in `lang/hamster-runner.js` `invokeInstanceMethodGen` (around lines 800-870) **before** the call reaches `state.runtime.callMethod` — it must block/yield, which the synchronous runtime adapter cannot do (research R3). Reject a second `start()` on an already-started thread with `Hamster <name> has already been started` carrying line/column (FR-004).
- [ ] T020 [US1] Resolve the thread body in `lang/hamster-scheduler.js`: a `run()` override on the hamster's class, or a separate `Runnable` behaviour object (FR-007, 2 corpus uses of `implements Runnable`). A thread with **no** `run()` finishes immediately with no error (FR-003). A direct `run()` call stays an ordinary method call, not a new thread.
- [ ] T021 [US1] Implement program-end semantics in `lang/hamster-scheduler.js`: keep running until every non-daemon thread is `TERMINATED` even after `main` returns (FR-005), then terminate any still-running daemon threads cleanly (FR-006).
- [ ] T022 [US1] Implement per-thread error isolation in `lang/hamster-scheduler.js`: an uncaught error inside one thread sets that thread's `exitError`, terminates only it, emits an `error` event for the UI, and leaves the other threads running (FR-008), matching `IHamster.java:49-56`'s `HamsterThreadExcHandler`.
- [ ] T023 [US1] Remove `THREAD_METHOD_NAMES` and `unsupportedThreadError` from `src/webview/simulator/runtime.js:39-44` and their two throw sites at `:184` (instance methods) and `:195` (`Thread.*` statics), so thread calls reach the runner's new interception instead of failing.
- [ ] T024 [US1] Rewrite the run loop in `src/webview/simulator/index.js` to drive the scheduler: replace the single `window.executeRunnerStep(runnerState)` call at `:151` inside `doStepInternal` with `scheduler.step()`, keep the single `runTimerId` `setTimeout` chain (do **not** create one timer per thread — constitution principle IV), and keep `doRun`/`doStep`/`doStop`/`doReset` wiring intact.
- [ ] T025 [US1] Make terminal input per-thread (research R9): replace the single `resumeAfterInput` slot at `src/webview/simulator/index.js:41` and the single `pendingInput` slot at `src/webview/simulator/engine.js:30` with per-thread pending-read records, and honour the hamster id in `engine.readInt(_hid = -1, …)` / `readString` (`engine.js:128-148`), which ignore it today. Only the asking hamster blocks; the scheduler keeps running the others.
- [ ] T026 [US1] Mark the hamster that acted last in `src/webview/simulator/renderer.js` (FR-032, SC-006) using `scheduler.current()`, extending `drawHamster` (line 91) and the render loop (line 111), which today tint only by `h.color`.
- [ ] T027 [P] [US1] Add smoke coverage in `scripts/language-smoke.cjs`: two threads interleave (assert both tags appear and the order is **not** all-of-one-then-all-of-the-other), both observe each other's writes to a shared global and a shared `static` field, a second `start()` errors, and a thread with no `run()` finishes silently.
- [ ] T028 [P] [US1] Replace — do not delete — the three thread-unsupported assertions at `test/simulatorRuntime.test.mjs:56-69` (which pin `/threads.*not supported/i`) with assertions pinning the new behaviour, so the change is covered rather than merely unpinned.

**Checkpoint**: Two hamsters visibly interleave. SC-006 and SC-002a demonstrable; MVP complete.

---

## Phase 4: User Story 2 - Mutual exclusion over shared terrain (Priority: P2)

**Goal**: Code marked `synchronized` gives real mutual exclusion, so protected and unprotected
versions of the same program behave differently.

**Independent Test**: quickstart.md Scenario 2 — the protected shared-counter program gives the
correct total on all 20 runs; the unprotected one is wrong at least once.

- [ ] T029 [US2] Implement the `Monitor` record and `enterMonitor(lock)` / `exitMonitor(lock)` in `lang/hamster-scheduler.js` per data-model.md §4: fields `lock`, `owner`, `depth`, `entryQueue`, `waitSet`, stored in `programState.monitors` keyed by lock object identity. Enforce the invariant **`depth > 0` ⇔ `owner !== null`**. `enterMonitor` is a generator function reached by `yield*` (constitution principle II).
- [ ] T030 [US2] Make monitors re-entrant in `lang/hamster-scheduler.js`: a thread already holding a lock increments `depth` and is let straight through; the lock is released only when the outermost section is left (FR-017).
- [ ] T031 [US2] Wire the `SynchronizedStatement` case in `lang/hamster-runner.js:571-578` to `enterMonitor`/`exitMonitor`, replacing the comment "The runner is single-threaded, so mutual exclusion holds without a real lock". Keep the existing `Cannot synchronize on null` error at `:574-576` unchanged.
- [ ] T032 [US2] Honour the `synchronized` method modifier in `lang/hamster-runner.js` `invokeUserFunctionGen`: an instance method locks `this`; a `static` method locks the class literal from `classLiteralFor(state, name)` (`:1243-1251`), which already returns one canonical frozen object per class so `Foo.class === Foo.class` holds and class-level locking needs no special case (research R6).
- [ ] T033 [US2] Release the monitor when a thread leaves a protected section **for any reason** — normal exit, an error propagating out, or abrupt termination — using a `finally` around the body in `lang/hamster-runner.js` (FR-018).
- [ ] T034 [US2] In `lang/hamster-scheduler.js`, put threads waiting at a monitor entrance into `BLOCKED` with `blockedOn` set, and resume exactly one from `entryQueue` when the lock is released (FR-019). A thread may appear in at most one `entryQueue` and at most one `waitSet` at a time (data-model.md §4).
- [ ] T035 [P] [US2] Add smoke coverage in `scripts/language-smoke.cjs` and unit coverage in `test/scheduler.test.mjs`: at most one thread inside a protected section at a time; re-entrancy depth honoured; class-level locking excludes across instances; a protected shared counter is always correct while an unprotected one can be wrong; monitor released when an exception unwinds out of the section.

**Checkpoint**: US1 and US2 both work. SC-002 demonstrable.

---

## Phase 5: User Story 3 - Hamsters wait for and signal each other (Priority: P3)

**Goal**: `wait`/`notify`/`notifyAll` let students build semaphores, bounded buffers, and
philosopher solutions; a stuck program says so instead of freezing.

**Independent Test**: quickstart.md Scenario 3 — the student-built `Semaphor`, the bounded
producer/consumer, and the dining philosophers all run without losing or duplicating grain and
without the simulator freezing; a deliberately deadlocking solution reports the deadlock.

- [ ] T036 [US3] Implement `monitorWait(lock, timeoutMs)` and `monitorNotify(lock, all)` in `lang/hamster-scheduler.js`: `wait` releases the monitor, moves the thread to the `waitSet` with status `WAITING`, and **saves the full re-entrancy depth** so a thread that entered three times still holds it three times after waking (data-model.md §4).
- [ ] T037 [US3] In `lang/hamster-scheduler.js`, make a signalled thread re-acquire the monitor before continuing (FR-022): it leaves `waitSet` into `entryQueue` with status `BLOCKED`, never straight to `RUNNABLE`.
- [ ] T038 [US3] Intercept `wait` / `notify` / `notifyAll` in `lang/hamster-runner.js` instance-call dispatch, rejecting a call by a thread that does not own the monitor with `<op> requires the monitor of the object (use synchronized)` plus line/column (FR-023).
- [ ] T039 [US3] Implement timed waiting in `lang/hamster-scheduler.js` using the scheduler's step counter as the simulation clock (research R7): `wait(ms)` sets `wakeAtStep` and status `TIMED_WAITING`, and the thread resumes when the limit expires even with no signal (FR-024). Convert milliseconds to steps via the single documented `STEPS_PER_MILLISECOND` constant.
- [ ] T040 [US3] Implement `isDeadlocked()` and `deadlockReport()` in `lang/hamster-scheduler.js` (FR-031): no `RUNNABLE` thread, no `TIMED_WAITING` thread whose `wakeAtStep` is reachable, and at least one non-`TERMINATED` thread. The report names each thread, its status, and what it waits for.
- [ ] T041 [US3] Surface the deadlock in `src/webview/simulator/index.js`: on `StepResult.status === 'deadlocked'`, stop the run loop and show the report rather than leaving the simulator apparently hung (SC-005 requires this within 2 seconds).
- [ ] T042 [P] [US3] Add smoke coverage in `scripts/language-smoke.cjs` and unit coverage in `test/scheduler.test.mjs`: `wait` releases and re-acquires at the right depth; `notify` wakes one and `notifyAll` wakes all; ownership violations error; a timed wait expires with no signal; a two-lock cycle is reported as a deadlock rather than hanging.

**Checkpoint**: US1–US3 work. SC-003 and SC-005 demonstrable.

---

## Phase 6: User Story 4 - Control the lifetime of helper hamsters (Priority: P4)

**Goal**: `join`, `sleep`, `interrupt`, daemon marking, and `stop` let a boss hamster send out
helpers and cancel them.

**Independent Test**: quickstart.md Scenario 4 — `kapitel 10/abschnitt 10.5/daemonen.ham`: the
boss resumes as soon as the first helper reports, the `catch (InterruptedException exc)` branch is
taken, and the remaining daemon helper does not keep the program alive.

- [ ] T043 [US4] Add `InterruptedException` to `BUILTIN_EXCEPTION_SUPERTYPES` in `lang/hamster-runner.js:31-47` as `InterruptedException → Exception → Throwable → Object`, so the existing `exceptionMatchesType` path matches `catch (InterruptedException exc)` — it appears in 70 corpus programs.
- [ ] T044 [US4] Implement `join(thread, timeoutMs)` and `sleep(ms)` as generator functions in `lang/hamster-scheduler.js`: `join` returns immediately if the target is already `TERMINATED`, otherwise status `JOINING`; `sleep` uses the simulation clock and **does not release held monitors** (Java semantics, `contracts/ham-thread-api.md`). Both throw `InterruptedException` if interrupted.
- [ ] T045 [US4] Implement `interrupt(thread)`, `isInterrupted()` (reads without clearing) and `Thread.interrupted()` (reads **and clears** the current thread's flag) in `lang/hamster-scheduler.js`: interrupting a thread that is `BLOCKED`, `WAITING`, `TIMED_WAITING` or `JOINING` wakes it with `InterruptedException`; interrupting a `RUNNABLE`/`RUNNING` thread only sets the flag (FR-027, data-model.md §3).
- [ ] T046 [US4] Implement `setDaemon(boolean)` / `isDaemon()` (erroring with `setDaemon must be called before start()` if called later), `isAlive()`, `setName(String)` / `getName()`, and `setPriority(int)` / `getPriority()` validating **1–10** with `Thread priority must be between 1 and 10` (FR-028, `contracts/ham-thread-api.md`).
- [ ] T047 [US4] Implement `stopThread(thread)` in `lang/hamster-scheduler.js` for abrupt termination, releasing **every** monitor in `monitorsHeld` so other threads are not stranded (FR-029), and leaving `monitorsHeld` empty.
- [ ] T048 [US4] Implement `Thread.currentThread()` and `Thread.yield()` in `lang/hamster-scheduler.js` and intercept them on the builtin path in `lang/hamster-runner.js` (around lines 940-945), where `Thread.*` statics currently resolve via `resolveIdentifier` → `{__kind:'class', name:'Thread'}` → `callBuiltin('Thread.sleep', …)`.
- [ ] T049 [US4] Wire every remaining member from `contracts/ham-thread-api.md` into the instance-call dispatch in `lang/hamster-runner.js`, so `join`, `sleep`, `interrupt`, `isInterrupted`, `isAlive`, `setDaemon`, `isDaemon`, `setName`, `getName`, `setPriority`, `getPriority` and `stop` are intercepted before reaching `state.runtime.callMethod`.
- [ ] T050 [P] [US4] Add smoke coverage in `scripts/language-smoke.cjs` and unit coverage in `test/scheduler.test.mjs`: `join` resumes on termination; `interrupt` breaks a `join`/`sleep`/`wait` with a catchable `InterruptedException`; `Thread.interrupted()` clears while `isInterrupted()` does not; a daemon thread does not keep the program alive; `stop()` releases held monitors; `setDaemon` after `start()` errors; priority outside 1–10 errors.

**Checkpoint**: US1–US4 work. The full chapter 10 teaching sequence runs.

---

## Phase 7: User Story 5 - Observe and debug a concurrent program (Priority: P5)

**Goal**: Each live hamster is its own selectable DAP thread with its own call stack, scopes, and
variables; stepping advances the selected hamster.

**Independent Test**: quickstart.md Scenario 5 — with a breakpoint inside `run()`, the Call Stack
view lists `main` plus one entry per started hamster by name; each shows its own frames and locals
with no cross-talk; a blocked hamster shows its stack and what it waits for; stepping advances the
selected thread; threads appear and disappear as hamsters start and finish.

- [ ] T051 [US5] Extend `src/webviewProtocol.ts` per `contracts/debug-protocol.md`: add `threadId: number` to `dbg:next`, `dbg:stepIn`, `dbg:stepOut`, `dbg:stackTrace` (host→webview) and to `dbg:stopped`, `dbg:stackTrace` (webview→host); add the new types `dbg:threads` (both directions), `dbg:threadStarted`, `dbg:threadExited`; add optional `threadId?: number` to `dbg:output`. Use precise types — no `any` (constitution principle VI).
- [ ] T052 [US5] Add a guard case for every new message type and a `threadId` check on the changed ones in `isPanelToHostMessage` (`src/webviewProtocol.ts:69-100`); `dbg:stopped` at `:81-82` currently validates only `reason`. A new type added to the union without a guard case is **silently discarded** at `src/hamsterPanel.ts:144-151`.
- [ ] T053 [P] [US5] Extend `test/webviewProtocol.test.cjs` with accept and reject cases for each new and changed debug message type.
- [ ] T054 [US5] Namespace the colliding debugger ids per data-model.md §6: frame id becomes `thread.id * FRAME_ID_STRIDE + frameIndex + 1` (replacing `i + 1` at `src/webview/simulator/debugger.js:304`) and Locals `variablesReference` becomes `LOCALS_BASE + frameId` (replacing `1000 + frameId` at `:312`), both as named constants chosen so a frame id decodes unambiguously back to `(threadId, frameIndex)`. Update the decode sites at `:328-329`. Globals `variablesReference` stays the literal `1` (`:313`, matched `:322`) because globals are genuinely shared.
- [ ] T055 [US5] Make `stateForEvaluation` in `lang/hamster-runner.js:293-311` resolve `frameId` against **that thread's** `ThreadState` rather than a single global state, keeping the existing deep-clone-and-refuse-side-effects behaviour (`validateDebuggerExpression`, the `needsInput` and `instruction` rejections at `:279-284`).
- [ ] T056 [US5] Make `sendStackTrace`, `sendScopes`, `sendVariables` and `evaluate` in `src/webview/simulator/debugger.js:287-366` thread-aware: resolve the target thread from the incoming `threadId` or from the thread encoded in the frame id / `variablesReference`, and read that thread's `frames`/`scopes`. An unknown `threadId` is an error response, never a silent fallback to thread 1 (`contracts/debug-protocol.md` invariant 1).
- [ ] T057 [US5] Implement per-thread stepping with stop-the-world semantics in `src/webview/simulator/debugger.js`: a breakpoint or error stops the whole program (so `allThreadsStopped: true` becomes true by construction rather than merely asserted), while `next`/`stepIn`/`stepOut` advance the **selected** thread. Report which thread actually advanced when the selected one could not proceed (FR-034). Fix `stepOut`'s `startingDepth <= 1 → continueRun()` shortcut at `:211-213`, which assumes the bottom frame is `main` — false for a spawned hamster's root frame.
- [ ] T058 [US5] Emit `dbg:threadStarted` / `dbg:threadExited` from `src/webview/simulator/debugger.js` as threads appear and disappear, driven by `StepResult.events`, and answer `dbg:threads` from `scheduler.liveThreads()`. Add the dispatch cases to the host-message switch at `src/webview/simulator/index.js:400-414`.
- [ ] T059 [US5] Update `src/hamsterDebugSession.ts`: replace the hard-coded `threads` response `[{ id: 1, name: 'Hamster' }]` at `:201` with a `dbg:threads` round trip; send `threadId: msg.threadId` instead of the literal `1` in the `stopped` event at `:142`; emit DAP `thread` events with `reason: 'started'`/`'exited'`; forward `request.arguments.threadId` in `stackTrace` (`:437-452`) and in `next`/`stepIn`/`stepOut` (`:221-234`). Leave `continue`'s `allThreadsContinued: true` (`:217`) and the `initialize` capabilities (`:176-186`) as they are — deliberately **not** advertising `supportsSingleThreadExecutionRequests` (research R10).
- [ ] T060 [US5] Show a blocked thread's state in `src/webview/simulator/debugger.js` (FR-033, SC-009): a thread that is `BLOCKED`, `WAITING`, `TIMED_WAITING` or `JOINING` reports its status and what it is waiting for in the `dbg:threads` response, so selecting it shows both its call stack and the reason it is stopped.

**Checkpoint**: All five user stories work. SC-008 and SC-009 demonstrable.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: The documentation the constitution requires in the same change, plus the full
validation sweep.

- [ ] T061 [P] Update `spec/vscode-port-status.md` at lines 28, 42, 84, 85 and the Debugger section at 112 (FR-038): concurrency is no longer a runtime gap; `synchronized` now locks (replacing the "performs no locking, because the runner is single-threaded" deviation at `:84`); `start()`/`run()` are supported and the DAP exposes one thread per hamster (replacing `:85`). Record the deliberate deviations: varied-but-not-reference scheduling, priority weighting inverted versus `IHamster.java:80`, simulation-clock `sleep`, no `$_dibo_p_intern$` marker, and non-reproducible concurrent runs.
- [ ] T062 [P] Update the "Current Feature Gaps" list in `.agents/skills/hamster-language/SKILL.md:154-155`, removing "No concurrency (`start()`/`run()`); `synchronized` runs without locking (single thread)" and narrowing the library-class gap to the still-unsupported `java.util.concurrent.*`, `java.util.Timer`/`TimerTask` and collection classes. Note that the dead `state.stack` field is gone (research R12).
- [ ] T063 [P] Add the user-visible feature to `CHANGELOG.md`.
- [ ] T064 Run `node scripts/concurrency-corpus.cjs` and record the result against the corrected SC-001 target of 95 programs, reporting the other 63 by category rather than as concurrency failures.
- [ ] T065 Run `npm test` and `npm run compile`; both must pass (constitution principle V).
- [ ] T066 Run `npm run conformance` and confirm **no change** in the parse rate — this feature adds no syntax, so conformance is a regression check, not a target (research R12). In PowerShell pass flags as `npm run conformance -- --min-pass-rate=1`.
- [ ] T067 Work through quickstart.md Scenarios 1–7 in the Extension Development Host (F5), including the checklist items: Stop and Reset mid-run leave no hamster moving and no stray timer, and a `while (true)` hamster runs until Stop without a loop-limit error.
- [ ] T068 Repeat quickstart.md Scenario 1 in the Web Extension Host (`Developer: Open Web Extension Host`) to confirm no Node-only API, no timer leak and no blocking of the extension host (constitution principle IV).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately. T001–T003 (spec corrections) are independent of T004–T007 (scaffolding).
- **Foundational (Phase 2)**: Depends on T004 (scheduler module exists). **BLOCKS all user stories.**
- **User Stories (Phases 3–7)**: All depend on Phase 2. Unusually for this template, they are **mostly sequential** here because each builds on the previous story's scheduler primitives — see below.
- **Polish (Phase 8)**: Depends on the user stories you intend to ship.

### User Story Dependencies

- **US1 (P1)**: Depends only on Foundational. **Independently shippable as the MVP.**
- **US2 (P2)**: Depends on US1 — a lock is meaningless without threads to exclude. Independently *testable* once US1 is in.
- **US3 (P3)**: Depends on US2 — `wait`/`notify` are defined in terms of releasing and re-acquiring a monitor.
- **US4 (P4)**: Depends on US1 only. **Can be built in parallel with US2/US3** by a second developer (it touches scheduler lifetime operations, not monitors), except T044's "does not release held monitors" note, which is a comment until US2 lands.
- **US5 (P5)**: Depends on US1 for threads to show. Richer once US2–US4 exist (blocked-state display in T060 needs US2/US3 statuses) but the thread list, per-thread stacks and stepping work with US1 alone.

### Within Each User Story

- Scheduler primitives before runner interception before UI wiring.
- Tests come last within a story here (the repo's convention is regression coverage, not TDD) but are **not optional** — constitution principle V.

### Parallel Opportunities

- **Phase 1**: T001, T002, T003 (spec edits) all parallel with each other; T005, T006, T007 parallel once T004 exists.
- **Phase 2**: T016 and T017 parallel once T008–T015 land.
- **Within each story**: the test task (T027/T028, T035, T042, T050, T053) is parallel with the others in its phase.
- **Across stories**: US4 can proceed in parallel with US2+US3 after US1.
- **Phase 8**: T061, T062, T063 (three different documentation files) all parallel.

---

## Parallel Example: Phase 1 Setup

```bash
# Spec corrections — three independent edits to the same file's distinct sections:
Task: "Correct SC-001 in specs/003-cooperative-threads/spec.md"
Task: "Replace SC-004 in specs/003-cooperative-threads/spec.md"
Task: "Add FR-012 deviation note in specs/003-cooperative-threads/spec.md"

# After T004 creates the module, three different files:
Task: "Re-export scheduler in src/webview/langBundleEntry.js"
Task: "Create test/scheduler.test.mjs harness"
Task: "Create scripts/concurrency-corpus.cjs"
```

## Parallel Example: US2 + US4 after US1

```bash
# Developer A — monitors (lang/hamster-scheduler.js monitor section + runner synchronized sites):
Task: "T029 Monitor record and enterMonitor/exitMonitor"
Task: "T031 Wire SynchronizedStatement"

# Developer B — lifetime control (lang/hamster-scheduler.js lifetime section + runner dispatch):
Task: "T044 join and sleep"
Task: "T045 interrupt / isInterrupted / Thread.interrupted"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1: Setup — correct the success criteria, scaffold the module.
2. Phase 2: Foundational — the state split and scheduler core. **Blocks everything.**
3. Phase 3: US1.
4. **STOP and VALIDATE**: quickstart.md Scenario 1 plus `npm test`.
5. This alone turns the chapter 10.1/10.2 programs from dead to working.

### Incremental Delivery

1. Setup + Foundational → foundation ready, nothing user-visible yet.
2. + US1 → two hamsters interleave (**MVP**, SC-006, SC-002a).
3. + US2 → protected vs unprotected differ (SC-002).
4. + US3 → semaphores, producer/consumer, philosophers (SC-003, SC-005).
5. + US4 → the full chapter 10 sequence (daemons, join, interrupt).
6. + US5 → per-hamster debugging (SC-008, SC-009).
7. + Polish → documentation, corpus measurement, both hosts verified.

### Risk Notes

- **Phase 2 is the whole bet.** The state split is validated by the prototype in research.md R2 (two threads sharing statics and globals, round-robined through the real `executeRunnerStep`), but if the invariant in T010 is violated anywhere, globals fork silently and every later story is subtly wrong. Land T016 with it.
- **FR-010 makes concurrent runs non-reproducible**, so every test task above must assert interleaving-independent invariants (no grain lost or duplicated, a protected total always correct, the program terminates) and never one exact sequence of actions. The injectable `random` in T014 exists for test determinism only — it is not a user-facing seed.
- **T012's loop guard** is easy to get wrong in the safe-looking direction: resetting too eagerly disables the runaway protection entirely. Reset only on a hamster action or a blocking operation.

---

## Notes

- `[P]` = different files, no dependencies on incomplete tasks.
- `[Story]` maps each task to a user story for traceability; Setup, Foundational and Polish tasks carry no story label.
- `lang/*.js` must stay ES modules — never convert to CommonJS (constitution principle II).
- Commit per task or per logical group; do not mix refactors with behaviour changes (constitution principle VI).
- Stop at any checkpoint to validate a story independently.
