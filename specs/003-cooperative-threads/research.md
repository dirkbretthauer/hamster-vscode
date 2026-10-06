# Phase 0 Research: Cooperative Hamster Threads

**Feature**: `specs/003-cooperative-threads` | **Date**: 2026-10-06

All Technical Context unknowns are resolved below. Line references are to the repository at
branch `003-cooperative-threads`; reference-simulator references are to
`D:\Projects\hamstersimulator-v29-06-eclipse\...\hamstersimulator-2.9.6`.

---

## R1. What the reference simulator actually does

**Decision**: Model a started hamster as a thread whose scheduling points are exactly the hamster
commands, matching `IHamster`.

**Findings** (constitution principle I — the Java sources win over prose):

- `de/hamster/debugger/model/IHamster.java:33` — `public class IHamster extends Thread`. A hamster
  *is* a thread in the reference; `Hamster` (Band 3) inherits the same shape.
- Every command is `public synchronized` and ends with `_intern_sleep_200405()`
  (`IHamster.java:87-142`): `vor`, `linksUm`, `nimm`, `gib`, `vornFrei`, `maulLeer`, `kornDa`,
  `schreib`, `liesZahl`, `liesZeichenkette`. So **the reference's scheduling points are exactly the
  hamster commands**, which is what FR-009 specifies.
- `IHamster.java:49-56` — `start()` sets a static `parallel = true` flag and installs
  `HamsterThreadExcHandler`, which on an uncaught exception calls `ham.schreib("$_dibo_intern$" + e)`
  and lets the other threads continue. This is the source for FR-008.
- `IHamster.java:76-85` `_intern_verzoegern()` — the priority mechanism is a hack:
  `z = random() * (2 + Thread.MAX_PRIORITY - getPriority())`, and when `z == 0` it emits the marker
  instruction `"$_dibo_p_intern$"`. That marker is swallowed by the UI
  (`LogPanel.java:57-59`, `DialogTerminal.java:123`) and by `schreib` itself
  (`IHamster.java:148`); its only purpose is to push an extra no-op instruction through the
  `synchronized` processor, creating one more preemption opportunity.

**Consequence**: the reference has no real priority scheduler — only "higher priority ⇒ more
extra switch points". We implement FR-012 as explicit weighted selection instead, and record the
deviation (R5).

**Alternatives considered**: reproducing the `$_dibo_p_intern$` marker instruction verbatim —
rejected, because it is an artefact of the Java UI pipeline with no counterpart here, and it would
pollute the instruction log.

---

## R2. How to represent N threads in the runner  ✅ prototype-validated

**Decision**: One **program state** holding the program-wide maps, and N **thread states**, each a
plain object that holds the shared maps *by reference* plus its own
`scopes` / `frames` / `generator` / `finished` / `lastInstruction`. An external scheduler calls the
existing `executeRunnerStep(threadState)` on whichever thread it picks.

**Rationale**: an audit of every `state.*` access in `lang/hamster-runner.js` shows the split is
unusually clean — only five fields are per-thread:

| Field | Uses | Scope |
|---|---|---|
| `scopes` | 33 | **per-thread** (but `scopes[0]` is the shared globals Map) |
| `frames` | 16 | **per-thread** |
| `finished` | 4 | **per-thread** |
| `lastInstruction` | 3 | **per-thread** |
| `generator` | 3 | **per-thread** |
| `classes` | 19 | shared |
| `runtime` | 16 | shared |
| `functions` | 10 | shared |
| `staticFields` | 8 | shared |
| `enumConstants` | 2 | shared |
| `classLiterals` | 2 | shared |
| `staticInitializersByClass` | 1 | shared |
| `classInitialization` | 1 | shared |

Crucially, **no code aliases `state.scopes` or `state.frames` into a local that survives a `yield`**
— every access is a fresh `state.scopes…` / `state.frames…` lookup, and every push/pop is paired in
a `try/finally` around a `yield*` (`hamster-runner.js:466-473, 513-518, 550-560, 667-671, 969-988,
1375-1456`). Because the runner threads `state` through every generator as an explicit parameter,
giving each thread its own `state` object needs **no changes to the generator bodies at all**.

**Prototype**: `scratchpad/swap-proto.cjs` builds two thread states that share
`staticFields`/`classes`/`classLiterals`/`runtime` and share `scopes[0]`, then round-robins
`executeRunnerStep` over both. Result:

```
trace: M0:c=0  W0:c=0  M1:c=2  W1:c=2  M2:c=4  W2:c=4
shared global counter : 6 (expected 6)
shared static hits    : 6 (expected 6)
tag order             : MWMWMW
PROTOTYPE PASSED
```

Both threads observe each other's writes to a global and to a static field, locals stay private,
frames unwind cleanly, and the interleaving is real. Note `M0:c=0` and `W0:c=0` — the two threads
already observe the same pre-increment value, which is exactly the lost-update shape the Band 3
chapter 11 exercises teach.

**Alternatives considered**:

- *Register-bank swap* (one `state` object whose five per-thread fields are saved/restored on each
  switch). Works in principle for the same reason, but adds a swap step to every scheduling
  decision and a whole class of "forgot to swap" bugs. Rejected once the prototype showed plain
  separate state objects need no swap at all.
- *One interpreter instance per thread* (full `createRunnerState` per thread). Rejected: it would
  duplicate the class table and, worse, give every thread its *own* static fields, breaking the
  shared-counter exercises outright.
- *Rewriting the runner on async/await*. Rejected: it would abandon the generator protocol the
  debugger and simulator both depend on, violating constitution principle II.

---

## R3. Where thread operations must be intercepted

**Decision**: Intercept thread and monitor operations **inside the runner**, before the call
reaches `state.runtime.callMethod` / `callBuiltin`.

**Rationale**: these operations must *block*, which in this architecture means yielding to the
scheduler. The runtime adapter (`src/webview/simulator/runtime.js`) is a plain synchronous
function table — it returns values, it cannot `yield`. Today the adapter rejects them outright:

- `runtime.js:39-44` — `THREAD_METHOD_NAMES = {start, join, wait, notify, notifyAll, interrupt,
  sleep}` and `unsupportedThreadError`, thrown at `runtime.js:184` (instance) and `:195`
  (`Thread.*` statics).
- Dispatch path today for `paul.start()`: `invokeInstanceMethodGen` → `findMethod` finds no user
  `start` → not enum/exception → `isHamsterInstruction('start')` is false → falls through to
  `state.runtime.callMethod` → throws.

So the interception point is `invokeInstanceMethodGen` (`hamster-runner.js:~800-870`) for instance
calls and the non-member/builtin path (`:~940-945`) for `Thread.sleep` / `Thread.currentThread`,
plus the `SynchronizedStatement` case (`:571-578`) and `synchronized` method modifiers.

**Alternatives considered**: making the runtime adapter return a sentinel "I am blocking" object
that the runner translates into a yield. Rejected: it splits one decision across two layers for no
benefit, and the adapter has no access to the thread registry.

---

## R4. Where the scheduler lives

**Decision**: A new `lang/hamster-scheduler.js` ES module, owned by the language layer alongside
the runner, exporting a scheduler that the simulator webview and the debugger both drive.

**Rationale**: constitution principle II keeps the language pipeline together, and both consumers
need it:

- The simulator run loop is one `setTimeout` chain over a single state
  (`src/webview/simulator/index.js:148-180` `doStepInternal`, `:213-237` `doRun`, the single
  `executeRunnerStep` call at `:151`).
- The debugger has its own two loops (`src/webview/simulator/debugger.js:150` and `:227`, both with
  `{granularity:'statement'}`).

Putting the scheduler in `lang/` means it is covered by `scripts/language-smoke.cjs` without a
webview, which matters because there is no automated webview/DAP suite (constitution principle V).

**Alternatives considered**: putting the scheduler in `src/webview/simulator/`. Rejected: it would
be untestable by the existing fast suites and would duplicate across the two drive loops.

---

## R5. Scheduling policy (FR-010 varied interleaving, FR-012 priorities)

**Decision**: Weighted random choice among runnable threads at each switch point. Weight is derived
from priority (Java range 1–10, default 5) as `weight = priority`, so a priority-10 thread is
picked ten times as often as a priority-1 thread, and no runnable thread ever has weight 0 (no
starvation, satisfying FR-012).

Randomness comes from a single injectable source on the scheduler (defaulting to `Math.random`) so
tests can supply a deterministic sequence. **The product behaviour stays varied and non-reproducible
per the FR-010 decision** — the injection point exists for test determinism, not as a user-facing
reproducibility feature.

**Rationale**: FR-010 requires genuinely varied interleavings; FR-012 requires priorities to matter
without starvation. Weighted selection delivers both in one rule. Constitution principle V requires
fast regression tests, which would be impossible against an unseeded global `Math.random`.

**Alternatives considered**:

- Strict round-robin — rejected by the FR-010 decision (hides the races the exercises teach).
- Reproducing the reference's `MAX_PRIORITY - getPriority()` formula — rejected per R1; it inverts
  the intuitive meaning of priority and is an artefact.
- A user-facing seed setting — rejected: that was the distinguishing feature of the option not
  chosen for FR-010, and adding it anyway would quietly re-litigate the decision.

---

## R6. Monitors: lock identity, re-entrancy, wait sets

**Decision**: A `Map` from lock object → monitor record, held on the program state.

**Rationale**: every lock form resolves to a stable JavaScript object identity already:

| Source form | Lock object | Where it comes from |
|---|---|---|
| `synchronized (obj) { … }` | the evaluated object | `hamster-runner.js:573` |
| `synchronized` instance method | `this` | the receiver in `invokeUserFunctionGen` |
| `synchronized static` method | the class literal | `classLiteralFor(state, name)` `:1243-1251` |
| `synchronized (Foo.class)` | the same class literal | canonical per `state.classLiterals` |

`classLiteralFor` already returns **one canonical frozen object per class name**, so
`Foo.class === Foo.class` holds and class-level locking works without special-casing. User objects
(`{__kind:'object', __className, fields}`) and hamster objects (`{__kind:'hamster', id, className}`)
are ordinary objects with stable identity.

A plain `Map` (not `WeakMap`) is used so the deadlock reporter (FR-031) can enumerate every monitor
and say who holds what. The map is cleared on reset, so it cannot outlive a program run.

Monitor record: `{ owner, depth, entryQueue[], waitSet[] }`. Re-entrancy is the `depth` counter
(FR-017); release-on-unwind is a `finally` around the body (FR-018).

**Alternatives considered**: tagging lock objects with a hidden property. Rejected: it mutates user
objects, would leak into the debugger's variable display, and breaks on the frozen class literals.

---

## R7. Simulation clock for `sleep` and timed waits

**Decision**: A monotonic **step counter** on the scheduler is the clock. `sleep(ms)` and
`wait(ms)` convert milliseconds to a step budget via one documented constant.

**Rationale**: the spec's Assumptions require pausing and timed waiting to track the simulation,
not wall-clock, so stepping in the debugger and moving the speed slider behave sensibly. Wall-clock
would make `Thread.sleep(2000)` expire instantly while single-stepping and would make the debugger
unusable for chapter 10.1's `stop.ham`.

The conversion constant is a deviation from the reference and must be written up per FR-038.

**Alternatives considered**: real `Date.now()` deadlines — rejected above. Treating `sleep(n)` as a
plain yield regardless of `n` — rejected: `stop.ham` uses `Thread.sleep(2000)` specifically to let
the workers run for a while before being stopped, so the duration has to mean *something*
proportional.

---

## R8. The loop guard conflicts with long-running threads

**Decision**: Make the existing per-loop guard a **per-thread step budget** owned by the thread
state, and reset a thread's progress counter whenever it performs a hamster action or blocks.

**Rationale**: `hamster-runner.js:489-491` and `:500-502` hard-code
`if (++guard > 100000) throw new Error('Loop iteration limit exceeded')` per `while`/`do-while`
loop. `FrissHamster.run()` is `while (true) { … }` by design and is meant to run until the user
presses Stop (chapter 10.1), so the current guard would kill a legitimate program. FR-014 requires
the guard to keep protecting against genuinely stuck programs without aborting legitimate
concurrent ones.

Resetting on *observable progress* (a hamster action or a blocking operation) preserves the guard's
real purpose — catching a spin loop that does nothing — while letting a working hamster loop
forever. The literal `100000` also becomes a named constant, per the AGENTS.md "avoid magic values"
rule.

**Alternatives considered**: removing the guard when more than one thread is running. Rejected: a
single runaway thread would then hang the webview with no diagnostic.

---

## R9. Per-thread blocking terminal input

**Decision**: Move the single input slot to a per-thread pending-read record; only the asking
thread blocks, and the scheduler keeps running the others.

**Rationale**: the spec's edge cases require that reading a number blocks only the asking hamster.
Today both sides are single-slot:

- `src/webview/simulator/index.js:41` `resumeAfterInput` — one global continuation.
- `src/webview/simulator/engine.js:30` `pendingInput` — one string slot; `readInt(_hid = -1, …)`
  and `readString` at `engine.js:128-148` **ignore the hamster id entirely**.
- `engineState.terminal` is one `{needsInput, prompt, output}` for the whole simulator.

The `RunnerPause` mechanism itself still works per thread: `executeRunnerStep` converts a
`{kind:'needsInput'}` yield into a thrown `RunnerPause` (`hamster-runner.js:250-251`), so the
scheduler can catch it, park that one thread, and pick another.

**Alternatives considered**: queueing input requests and serving them one at a time while all
threads block. Rejected: it contradicts the stated edge case and would deadlock a program where one
hamster must act to produce the input another is waiting for.

---

## R10. Multi-thread DAP

**Decision**: Give every live thread a stable integer id; namespace frame ids and
`variablesReference` values by thread; emit `thread` started/exited events; keep **stop-the-world**
semantics (a breakpoint stops every thread) while allowing the user to step a *selected* thread.

**Rationale**: the per-hamster-threads decision (FR-033) requires it, and the current id formulas
collide across threads:

| Id | Current formula | File:line | Collides because |
|---|---|---|---|
| thread id | literal `1` | `hamsterDebugSession.ts:201`, `:142` | only one thread exists |
| frame id | `i + 1` over `state.frames` | `debugger.js:304`, decoded `hamster-runner.js:296`, `debugger.js:329` | index is per-frames-array |
| Locals varRef | `1000 + frameId` | `debugger.js:312`, decoded `:328` | same frame index in two threads |
| Globals varRef | literal `1` | `debugger.js:313`, matched `:322` | genuinely shared — stays as is |

Stop-the-world is the right default because execution is genuinely cooperative: only one thread is
ever mid-action, so stopping everything yields a consistent snapshot of every hamster. It also lets
`allThreadsStopped: true` (`hamsterDebugSession.ts:143`) stay truthful, where today it is asserted
without being computed.

**Alternatives considered**: `supportsSingleThreadExecutionRequests` with per-thread resume.
Rejected for this feature: it multiplies the stepping state machine (`dbgActive`, `dbgRunning`,
`dbgTimerId`, `dbgOperationId` are module-level singletons at `debugger.js:44-48`) for a teaching
scenario where a consistent whole-program snapshot is what a class actually wants.

---

## R11. How much of the reference corpus this can actually reach

**Decision**: Target the **95 programs** that need nothing beyond threads and monitors, and treat
the remaining 63 as out of scope or blocked on pre-existing gaps. **This contradicts SC-001 as
written and the spec must be corrected** (see plan.md → Spec Issues).

**Measurement** (script re-run over the corpus at `…/hamstersimulator-2.9.6/Programme`, 950 `.ham`
files, matching `.start()` / `extends Thread` / `synchronized` / `implements Runnable`):

| Group | Count |
|---|---|
| Concurrency-using programs | **158** |
| ├─ blocked by `java.util.concurrent.*` / `java.util.Timer` | 9 |
| ├─ blocked by collection classes (`ArrayList`, `HashMap`, …) | 5 |
| ├─ need only `util.AllroundHamster` (a corpus `/*class*/` file, pre-existing import concern) | 49 |
| └─ **need nothing beyond threads + monitors** | **95** |

Distinct imports among concurrency programs: `java.util.Timer`, `java.util.TimerTask`,
`java.util.concurrent.{Callable, CountDownLatch, CyclicBarrier, Exchanger, ExecutionException,
FutureTask, Semaphore}`, `util.AllroundHamster`.

The spec's own Assumptions already place "executor services, concurrency utilities" out of scope,
so SC-001's "all 159 … none failing because a concurrency feature is unsupported" cannot hold:
`java.util.concurrent.Semaphore` *is* a concurrency feature. The honest, measurable targets are 95
(this feature) and up to 144 once `util.AllroundHamster` resolution is addressed separately.

Note the spec says "159" and the re-measurement says 158; the earlier count included
`band 2/kapitel 16/abschnitt 3/graphik.ham`, which matches `synchronized` only in a comment.

**Alternatives considered**: implementing `java.util.concurrent.Semaphore` and friends to reach
158. Rejected: the course material deliberately has students *build* a `Semaphor` class
(`kapitel 12/abschnitt 12.1/.../Semaphor.ham` uses only `wait`/`notify`), so the library versions
are a convenience, not the lesson. Out of scope per the spec's Assumptions.

---

## R12. Incidental findings

- **Dead field**: `state.stack` is declared at `hamster-runner.js:~200` ("Legacy stack field kept
  for backward-compatible state inspection") and **never read or written anywhere**. Removing it is
  a one-line cleanup in code this feature already touches; the `hamster-language` skill's gap list
  should note it is gone.
- **Existing tests pin the old behaviour**: `test/simulatorRuntime.test.mjs:56-69` asserts
  `/threads.*not supported/i` for three thread methods. Those three assertions must be replaced,
  not deleted, so the new behaviour is pinned instead.
- **Port-status lines to update** (FR-038): `spec/vscode-port-status.md:28`, `:42`, `:84`
  (the "performs no locking" deviation), `:85` (the "No `start()`/`run()` concurrency … single
  synthetic DAP thread" gap), and the Debugger section at `:112`.
- **Skill gap list to update**: `.agents/skills/hamster-language/SKILL.md:154-155`.
- **No parser work is expected.** `synchronized` already lexes (`hamster-lexer.js:36`), parses as a
  statement (`hamster-parser.js:685-686, 856-865`) and as a method modifier (`:2141`), and all 920
  Java-like samples already parse. `scripts/conformance.cjs` is parse-only, so it should show **no
  change**; running it is a regression check, not a target.
