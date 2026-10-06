# Contract: `.ham` thread and monitor API

**Feature**: `specs/003-cooperative-threads`

The language surface a student's `.ham` program may use. Scope is fixed by the spec's Assumptions:
the members the reference course material actually uses. Usage counts are from the 950-program
reference corpus and justify inclusion.

## Thread members on a hamster (or any `extends Thread` / `implements Runnable` class)

| Member | Corpus uses | Blocking | Behaviour |
|---|---|---|---|
| `start()` | 206 | no | Creates the thread and makes it `RUNNABLE`. Error if already started (FR-004). Error if the thread cap is exceeded. |
| `run()` | 2 explicit | no | The thread body. Absent ⇒ the thread finishes at once, no error (FR-003). A direct call is an ordinary method call, **not** a new thread. |
| `join()` / `join(ms)` | 15 | **yes** | Wait for that thread to terminate. Returns at once if already terminated. `ms` uses the simulation clock. Throws `InterruptedException` if interrupted. |
| `interrupt()` | 14 | no | Sets the flag; wakes the target from `sleep`/`wait`/`join` with `InterruptedException` (FR-027). |
| `isInterrupted()` | 2 | no | Reads the flag without clearing it. |
| `isAlive()` | 6 | no | `true` once started and not yet terminated. |
| `setDaemon(boolean)` / `isDaemon()` | 4 | no | Helper threads do not keep the program alive (FR-006). Must be called before `start()`. |
| `setPriority(int)` / `getPriority()` | 3 | no | 1–10, default 5. Selection weight (research R5). |
| `setName(String)` / `getName()` | 5 | no | Also the name shown in the debugger's thread list. |
| `stop()` | 3 | no | Abrupt termination; releases every monitor held (FR-029). Deprecated in Java, required by chapter 10.1's `stop.ham`. |

## Static members

| Member | Corpus uses | Blocking | Behaviour |
|---|---|---|---|
| `Thread.sleep(ms)` | 23 | **yes** | Pause on the simulation clock (research R7). Throws `InterruptedException`. Does **not** release held monitors (Java semantics). |
| `Thread.currentThread()` | 3 | no | The acting thread; `getName()` on it is the common use. |
| `Thread.yield()` | 1 | no | Offer a switch (FR-011). |
| `Thread.interrupted()` | 2 | no | Reads **and clears** the current thread's flag. |

## Monitor members on any object

| Member | Corpus uses | Blocking | Behaviour |
|---|---|---|---|
| `wait()` / `wait(ms)` | 35 | **yes** | Release the monitor, suspend, re-acquire before continuing (FR-020, FR-022). Requires ownership (FR-023). Full re-entrancy depth is restored on wake. |
| `notify()` | 17 | no | Wake one thread in the wait set. Requires ownership. |
| `notifyAll()` | 22 | no | Wake all threads in the wait set. Requires ownership. |

## Language forms

| Form | Corpus uses | Lock object |
|---|---|---|
| `synchronized (expr) { … }` | part of 147 | the evaluated object; `null` is a runtime error (already enforced at `hamster-runner.js:574`) |
| `synchronized` instance method | part of 147 | `this` |
| `synchronized static` method | part of 147 | the class literal (canonical per `classLiterals`) |
| `class X extends Thread` | 9 | — |
| `class X implements Runnable` | 2 | — |

## Exception type

`InterruptedException` joins `BUILTIN_EXCEPTION_SUPERTYPES` (`hamster-runner.js:31-47`) as
`InterruptedException → Exception → Throwable → Object`. It appears in 70 corpus programs, almost
always as `catch (InterruptedException exc) {}`, so `catch` matching must work through the existing
`exceptionMatchesType` path.

## Explicitly out of scope

`java.util.concurrent.*` (`Semaphore`, `CountDownLatch`, `CyclicBarrier`, `Exchanger`,
`FutureTask`, `Callable`), `java.util.Timer` / `TimerTask`, `ThreadGroup`, `ThreadLocal`,
collection classes. These keep failing with the existing "class … is not provided by the Hamster
simulator" message (`runtime.js:46-48`). The course material has students *build* a `Semaphor`
class from `wait`/`notify`, so the library versions are not the lesson (research R11).

## Error contract

Every failure throws with a message and source location, in the existing style (FR-041):

| Condition | Message shape |
|---|---|
| `start()` on a started thread | `Hamster <name> has already been started` |
| thread cap exceeded | `Too many hamster threads (limit <n>)` |
| `wait`/`notify`/`notifyAll` without ownership | `<op> requires the monitor of the object (use synchronized)` |
| `synchronized (null)` | `Cannot synchronize on null` *(unchanged)* |
| `setDaemon` after `start()` | `setDaemon must be called before start()` |
| `setPriority` out of 1–10 | `Thread priority must be between 1 and 10` |
| deadlock | `All hamsters are blocked` + per-thread status and what each waits for (FR-031) |
