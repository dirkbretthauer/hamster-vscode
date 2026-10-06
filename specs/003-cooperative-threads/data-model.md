# Phase 1 Data Model: Cooperative Hamster Threads

**Feature**: `specs/003-cooperative-threads` | **Date**: 2026-10-06

Entities derive from the spec's Key Entities section and the Phase 0 decisions (R2, R6, R7).
All structures are plain objects, per the repository's AST/state convention.

---

## 1. ProgramState

The program-wide half of today's runner state. Created once per run; shared **by reference** with
every thread (research R2).

| Field | Type | Notes |
|---|---|---|
| `ast` | object | Entry program AST |
| `functions` | `Map<string, FunctionDecl[]>` | Unchanged |
| `classes` | `Map<string, ClassDecl>` | Unchanged |
| `staticFields` | `Map<string, Map<string, value>>` | **Shared mutable** — the chapter 11 counter lives here |
| `staticInitializers`, `staticInitializersByClass` | arrays / Map | Unchanged |
| `classInitialization` | `Map<string, {status, error}>` | Shared; a class initialises once for the whole program |
| `enumConstants` | `Map<string, EnumConstant[]>` | Unchanged |
| `classLiterals` | `Map<string, frozen object>` | Canonical per class — doubles as the class-level lock identity (R6) |
| `runtime` | object | The simulator runtime adapter |
| `globalScope` | `Map<string, value>` | The single globals Map; every thread's `scopes[0]` |
| `monitors` | `Map<object, Monitor>` | Lock object → monitor record (R6) |
| `scheduler` | `Scheduler` | Back-reference so the runner can reach thread operations |

**Validation**: `classInitialization` must stay program-wide — two threads touching the same class
must run its static initialiser exactly once (a thread that arrives while `status === 'initializing'`
returns immediately, as today at `hamster-runner.js:409`).

---

## 2. ThreadState

One per thread. Holds the shared fields by reference plus the five private registers identified in
R2, so every existing runner generator works unmodified.

| Field | Type | Notes |
|---|---|---|
| *(all ProgramState fields)* | — | Copied **by reference** at creation |
| `scopes` | `Map[]` | **Private.** `scopes[0]` is `ProgramState.globalScope` (same object) |
| `frames` | `Frame[]` | **Private.** `{name, loc, scopeIndex, callerLoc, className}` |
| `generator` | Generator | **Private.** This thread's execution |
| `finished` | boolean | **Private.** |
| `lastInstruction` | object \| null | **Private.** Drives line highlighting and `dbgIsAtCallSite` |
| `thread` | `Thread` | Back-reference to the scheduler record below |

**Validation**: `scopes[0] === ProgramState.globalScope` must hold for every thread, or globals
silently fork (prototype-asserted).

---

## 3. Thread

The scheduler's record for one strand of execution. Maps to the spec's "Hamster thread" entity and
to one DAP thread.

| Field | Type | Notes |
|---|---|---|
| `id` | number | Stable, monotonic from 1. Thread 1 is always `main`. Also the DAP thread id (R10) |
| `name` | string | `"main"`, else the hamster's name; settable (FR-028) |
| `state` | `ThreadState` | Its registers |
| `hamster` | object \| null | The hamster object whose `run()` this executes; `null` for `main` |
| `status` | `ThreadStatus` | See state machine below |
| `daemon` | boolean | FR-028; default `false`, inherited as `false` |
| `priority` | number | 1–10, default 5. Selection weight (R5) |
| `interrupted` | boolean | The interrupt flag (FR-027) |
| `blockedOn` | object \| null | The monitor lock object, or the thread being joined |
| `wakeAtStep` | number \| null | Scheduler step at which a timed wait expires (R7) |
| `monitorsHeld` | `Array<{lock, depth}>` | Needed to release everything on abrupt termination (FR-029) and to report deadlocks (FR-031) |
| `progressCounter` | number | Per-thread runaway guard; reset on observable progress (R8) |
| `pendingInput` | object \| null | `{kind, prompt, resume}` while this thread alone blocks on terminal input (R9) |
| `exitError` | Error \| null | Set when the thread died from an uncaught error (FR-008) |

### ThreadStatus state machine

```
                    start()
   NEW ─────────────────────────────► RUNNABLE ◄──────────────────┐
                                       │   ▲                      │
                        scheduler picks│   │ scheduler switches    │
                                       ▼   │ away                  │
                                    RUNNING                        │
                                       │                           │
     ┌─────────────┬───────────────┬───┴───────┬──────────────┐    │
     │ enter a held│ wait()        │ sleep(n) /│ join(t)      │    │
     │ monitor     │               │ wait(n)   │              │    │
     ▼             ▼               ▼           ▼              │    │
  BLOCKED       WAITING      TIMED_WAITING   JOINING          │    │
     │             │               │           │              │    │
     │ monitor     │ notify() /    │ step >=   │ t finished / │    │
     │ released    │ notifyAll() / │ wakeAtStep│ interrupt()  │    │
     │             │ interrupt()   │ interrupt │              │    │
     └─────────────┴───────────────┴───────────┴──────────────┘────┘

   RUNNING ──► TERMINATED   (run() returned, uncaught error, stop(), or
                             program end with daemon == true)
```

**Validation rules**

- `start()` is legal only from `NEW`; from any other status it is the FR-004 error.
- A thread leaving `WAITING` must re-acquire its monitor before reaching `RUNNABLE` (FR-022) — it
  passes through `BLOCKED` to do so.
- `TERMINATED` is terminal; `monitorsHeld` must be empty after the transition (FR-018, FR-029).
- `interrupted` set while `BLOCKED`, `WAITING`, `TIMED_WAITING` or `JOINING` wakes the thread with
  an `InterruptedException`; set while `RUNNABLE`/`RUNNING` it only sets the flag (FR-027).

---

## 4. Monitor

One record per lock object, in `ProgramState.monitors` (R6).

| Field | Type | Notes |
|---|---|---|
| `lock` | object | The key: a user object, a hamster object, or a canonical class literal |
| `owner` | `Thread` \| null | Current holder |
| `depth` | number | Re-entrancy count; `0` ⇔ `owner === null` (FR-017) |
| `entryQueue` | `Thread[]` | Threads in `BLOCKED` waiting to acquire (FR-019) |
| `waitSet` | `Thread[]` | Threads in `WAITING`/`TIMED_WAITING` on this monitor (FR-020) |

**Validation rules**

- `depth > 0` ⇔ `owner !== null`.
- `wait()`/`notify()`/`notifyAll()` require `owner === currentThread`, else the FR-023 error.
- On `wait()` the full `depth` is saved on the thread and restored on re-acquisition — a thread
  that entered a monitor three times must still hold it three times after waking.
- A thread may appear in at most one `entryQueue` and at most one `waitSet` at a time.

---

## 5. Scheduler

| Field | Type | Notes |
|---|---|---|
| `threads` | `Thread[]` | Every thread, live and terminated, in creation order |
| `current` | `Thread` \| null | The thread that last acted — drives FR-032 |
| `step` | number | Monotonic counter; the simulation clock (R7) |
| `random` | `() => number` | Injectable; defaults to `Math.random` (R5) |
| `maxThreads` | number | Documented cap, enforced on `start()` |

**Derived queries**

- `runnable()` — threads with `status === RUNNABLE`.
- `pick()` — weighted random over `runnable()` by `priority` (R5).
- `isDeadlocked()` — no `RUNNABLE` thread, no `TIMED_WAITING` thread whose `wakeAtStep` is
  reachable, and at least one non-`TERMINATED` thread (FR-031).
- `isFinished()` — every non-daemon thread is `TERMINATED` (FR-005, FR-006).

---

## 6. Identifier namespacing for the debugger (R10)

| Id | Formula | Replaces |
|---|---|---|
| DAP thread id | `thread.id` (1 = main) | literal `1` at `hamsterDebugSession.ts:201`, `:142` |
| Frame id | `thread.id * FRAME_ID_STRIDE + frameIndex + 1` | `i + 1` at `debugger.js:304` |
| Locals `variablesReference` | `LOCALS_BASE + frameId` | `1000 + frameId` at `debugger.js:312` |
| Globals `variablesReference` | literal `1` (unchanged) | `debugger.js:313` — genuinely shared |

`FRAME_ID_STRIDE` and `LOCALS_BASE` are named constants, chosen so that a frame id decodes
unambiguously back to `(threadId, frameIndex)`. Decoding sites to update in lockstep:
`debugger.js:328-329` and `hamster-runner.js:296` (`stateForEvaluation`), which must resolve the
frame against **that thread's** `ThreadState`, not a global one.
