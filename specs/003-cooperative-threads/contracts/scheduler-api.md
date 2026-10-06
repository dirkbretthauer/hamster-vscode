# Contract: `lang/hamster-scheduler.js` module API

**Feature**: `specs/003-cooperative-threads`

The interface between the language layer and its two drivers: the simulator run loop
(`src/webview/simulator/index.js`) and the debugger (`src/webview/simulator/debugger.js`).
Plain ES module, no build step, matching the `lang/*.js` convention (constitution principle II).

## Construction

```js
createScheduler(programState, options?) -> Scheduler
```

`options`: `{ random?: () => number, maxThreads?: number, stepsPerMillisecond?: number }`.
`random` defaults to `Math.random` and exists so tests can be deterministic — the shipped
behaviour stays varied (research R5). The other two default to named constants.

## Advancing

```js
scheduler.step(opts?) -> StepResult
```

Replaces the direct `executeRunnerStep(runnerState, opts)` calls at
`src/webview/simulator/index.js:151` and `src/webview/simulator/debugger.js:150, :227`.
`opts.granularity` is forwarded unchanged to the chosen thread (`'instruction'` | `'statement'`).

`StepResult`:

| Field | Type | Meaning |
|---|---|---|
| `status` | `'progressed' \| 'finished' \| 'deadlocked' \| 'needsInput'` | |
| `thread` | `Thread` \| null | Which thread acted — the source for FR-032 and `dbg:stopped.threadId` |
| `instruction` | object \| null | That thread's `lastInstruction` (drives line highlighting) |
| `events` | `ThreadEvent[]` | `{kind: 'started' \| 'exited' \| 'error', threadId, name?, error?}` since the last step |
| `report` | string \| null | On `'deadlocked'`, the per-thread explanation (FR-031) |

`'needsInput'` parks only the asking thread; the caller resolves it with `provideInput` and keeps
stepping the others (research R9). Only when **every** non-daemon thread is parked on input does
the UI show the prompt as blocking.

**Contract**: `step()` advances **at most one thread by at most one runner step**, so the existing
batching loops (`DEBUG_STEP_BATCH_SIZE = 100`, `DEBUG_STEP_TIME_SLICE_MS = 8` at `debugger.js:10-11`)
and the speed-slider pacing in `doRun` keep working unchanged.

## Thread operations (called by the runner, not by the UI)

```js
scheduler.spawn(hamsterObject, runMethod) -> Thread   // start()
scheduler.join(thread, timeoutMs?)                    // blocking
scheduler.sleep(ms)                                   // blocking
scheduler.yieldNow()
scheduler.interrupt(thread)
scheduler.stopThread(thread)
scheduler.enterMonitor(lock)                          // blocking
scheduler.exitMonitor(lock)
scheduler.monitorWait(lock, timeoutMs?)               // blocking
scheduler.monitorNotify(lock, all)
scheduler.currentThread() -> Thread
```

Blocking operations are **generator functions** — the runner reaches them with `yield*`
(constitution principle II). Non-blocking ones are plain functions.

## Inspection (for the UI and the debugger)

```js
scheduler.threads()        -> Thread[]     // live and terminated, creation order
scheduler.liveThreads()    -> Thread[]     // not TERMINATED — the DAP thread list
scheduler.current()        -> Thread|null  // last thread to act
scheduler.threadById(id)   -> Thread|null
scheduler.isFinished()     -> boolean      // every non-daemon thread TERMINATED
scheduler.deadlockReport() -> string|null
scheduler.reset()                          // drop all threads and monitors
```

## Invariants

1. Exactly one thread runs at a time; `step()` is the only place a switch happens.
2. Every thread's `state.scopes[0] === programState.globalScope`.
3. A thread in `monitorsHeld` appears as `owner` of each of those monitors, and vice versa.
4. After `TERMINATED`, `monitorsHeld` is empty.
5. `reset()` leaves no timers, no parked input, and no monitor records.
6. The scheduler never calls into the DOM, `vscode`, or the engine directly — it only advances
   thread generators and reports (keeps it testable from `scripts/language-smoke.cjs`).
