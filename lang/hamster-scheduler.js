/**
 * Cooperative scheduler for hamster threads.
 *
 * In the reference simulator a hamster *is* a thread (`IHamster extends Thread`)
 * and every hamster command is a scheduling point. This module reproduces that
 * shape without real parallelism: exactly one thread runs at a time and the
 * scheduler switches between them at the points the runner yields.
 *
 * Imports flow one way only — this module imports the runner, the runner never
 * imports this one. The runner reaches the scheduler at runtime through
 * `programState.scheduler`.
 */
import {
    createThreadState, createNativeThreadState, executeRunnerStep, invokeObjectMethodGen, RunnerPause,
} from './hamster-runner.js';

export const ThreadStatus = Object.freeze({
    NEW: 'new',
    RUNNABLE: 'runnable',
    RUNNING: 'running',
    BLOCKED: 'blocked',
    WAITING: 'waiting',
    TIMED_WAITING: 'timedWaiting',
    JOINING: 'joining',
    TERMINATED: 'terminated',
});

export const MIN_PRIORITY = 1;
export const DEFAULT_PRIORITY = 5;
export const MAX_PRIORITY = 10;

/** Generous enough for every course program; guards against a runaway `new`+`start` loop. */
export const DEFAULT_MAX_THREADS = 64;

/**
 * Simulation-clock conversion. Durations in `.ham` programs are written in Java
 * milliseconds, but waiting must track the simulation rather than wall-clock
 * time so that stepping in the debugger and moving the speed slider behave
 * sensibly. 0.01 makes the common `Thread.sleep(2000)` last 20 scheduler steps.
 */
export const STEPS_PER_MILLISECOND = 0.01;

/**
 * When every live thread is parked on a timed wait, gaps of up to this many
 * steps are still paced one step at a time, so a short `Thread.sleep` remains
 * visible at the chosen speed. Longer idle gaps (more than 10 simulated
 * seconds) are skipped in a single step; otherwise a `Timer` scheduled for
 * noon tomorrow would take hours of UI ticks to fire.
 */
export const MAX_PACED_IDLE_STEPS = 100;

/** Yielded while a thread is parked; never becomes `lastInstruction`. */
const BLOCKED_YIELD = Object.freeze({ kind: 'blocked' });

const MAIN_THREAD_NAME = 'main';

function interruptedError(operation) {
    const error = new Error(operation + ' was interrupted');
    error.hamsterExceptionType = 'InterruptedException';
    return error;
}

function schedulerError(message) {
    return new Error(message);
}

/** An error the runner turns into a catchable Java exception of `typeName`. */
function javaException(typeName, message) {
    const error = new Error(message);
    error.name = typeName;
    error.hamsterExceptionType = typeName;
    return error;
}

function durationToSteps(milliseconds) {
    const ms = Number(milliseconds);
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    return Math.max(1, Math.round(ms * STEPS_PER_MILLISECOND));
}

/**
 * @param {object} programState shared program-wide runner state
 * @param {object} [options] `{ random, maxThreads, now }`; `now()` returns the
 *   wall-clock epoch milliseconds the simulation clock starts from
 */
export function createScheduler(programState, options = {}) {
    const random = typeof options.random === 'function' ? options.random : Math.random;
    const maxThreads = options.maxThreads || DEFAULT_MAX_THREADS;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();

    const threads = [];
    let nextThreadId = 1;
    let current = null;
    let stepCount = 0;
    let pendingEvents = [];
    let clockOriginMillis = now();

    /** Timer object → its task queue and worker thread. */
    const timers = new Map();
    /** TimerTask object → its scheduling state. */
    const timerTasks = new Map();
    let nextTimerSerial = 0;

    /**
     * `setDaemon`/`setPriority`/`setName` may be called before `start()`, when
     * no thread record exists yet, so those settings are parked against the
     * hamster object until the thread is created.
     */
    const pendingSettings = new Map();

    function settingsFor(object) {
        let settings = pendingSettings.get(object);
        if (!settings) {
            settings = { daemon: false, priority: DEFAULT_PRIORITY, name: null };
            pendingSettings.set(object, settings);
        }
        return settings;
    }

    // ── thread records ──────────────────────────────────────────────────────

    function makeThread(name, hamster, state) {
        return {
            id: nextThreadId++,
            name,
            state,
            hamster,
            status: ThreadStatus.NEW,
            daemon: false,
            priority: DEFAULT_PRIORITY,
            interrupted: false,
            blockedOn: null,
            wakeAtStep: null,
            monitorsHeld: [],
            progressCounter: 0,
            pendingInput: null,
            exitError: null,
            pendingReentryDepth: 0,
        };
    }

    function liveThreads() {
        return threads.filter(thread => thread.status !== ThreadStatus.TERMINATED);
    }

    function runnableThreads() {
        return threads.filter(thread =>
            (thread.status === ThreadStatus.RUNNABLE || thread.status === ThreadStatus.RUNNING) &&
            thread.pendingInput === null);
    }

    /** Weighted by priority so a higher-priority thread is picked more often, never starving others. */
    function pick() {
        const candidates = runnableThreads();
        if (candidates.length === 0) return null;
        const total = candidates.reduce((sum, thread) => sum + thread.priority, 0);
        let ticket = random() * total;
        for (const thread of candidates) {
            ticket -= thread.priority;
            if (ticket < 0) return thread;
        }
        return candidates[candidates.length - 1];
    }

    // ── monitors ────────────────────────────────────────────────────────────

    function monitorFor(lock) {
        let monitor = programState.monitors.get(lock);
        if (!monitor) {
            monitor = { lock, owner: null, depth: 0, entryQueue: [], waitSet: [] };
            programState.monitors.set(lock, monitor);
        }
        return monitor;
    }

    function acquire(monitor, thread, depth) {
        monitor.owner = thread;
        monitor.depth = depth;
        if (!thread.monitorsHeld.includes(monitor)) thread.monitorsHeld.push(monitor);
    }

    function releaseFully(monitor, thread) {
        const depth = monitor.depth;
        monitor.owner = null;
        monitor.depth = 0;
        const index = thread.monitorsHeld.indexOf(monitor);
        if (index >= 0) thread.monitorsHeld.splice(index, 1);
        admitNextOwner(monitor);
        return depth;
    }

    /**
     * Hand the monitor straight to the next queued thread. Ownership must
     * transfer here rather than being left for the woken thread to take: if the
     * monitor were briefly unowned, a thread that is merely runnable could
     * acquire it first and two threads would end up inside the section.
     */
    function admitNextOwner(monitor) {
        if (monitor.owner !== null || monitor.entryQueue.length === 0) return;
        const next = monitor.entryQueue.shift();
        next.blockedOn = null;
        next.status = ThreadStatus.RUNNABLE;
        acquire(monitor, next, next.pendingReentryDepth || 1);
        next.pendingReentryDepth = 0;
    }

    // ── lifecycle ───────────────────────────────────────────────────────────

    function terminate(thread, error) {
        if (thread.status === ThreadStatus.TERMINATED) return;
        // Drop out of any queue it was parked in, so a dead thread can never be
        // handed a monitor.
        for (const monitor of programState.monitors.values()) {
            const queued = monitor.entryQueue.indexOf(thread);
            if (queued >= 0) monitor.entryQueue.splice(queued, 1);
            const waiting = monitor.waitSet.indexOf(thread);
            if (waiting >= 0) monitor.waitSet.splice(waiting, 1);
        }
        thread.pendingReentryDepth = 0;
        // Release everything so no other thread is stranded (FR-018, FR-029).
        for (const monitor of [...thread.monitorsHeld]) {
            monitor.owner = null;
            monitor.depth = 0;
            admitNextOwner(monitor);
        }
        thread.monitorsHeld.length = 0;
        thread.status = ThreadStatus.TERMINATED;
        thread.state.finished = true;
        thread.blockedOn = null;
        thread.wakeAtStep = null;
        thread.pendingInput = null;
        if (error) thread.exitError = error;
        pendingEvents.push({ kind: 'exited', threadId: thread.id, name: thread.name });
        if (error) {
            pendingEvents.push({
                kind: 'error', threadId: thread.id, name: thread.name, error,
            });
        }
        wakeJoiners(thread);
    }

    function wakeJoiners(target) {
        for (const thread of threads) {
            if (thread.status === ThreadStatus.JOINING && thread.blockedOn === target) {
                thread.blockedOn = null;
                thread.wakeAtStep = null;
                thread.status = ThreadStatus.RUNNABLE;
            }
        }
    }

    function wakeExpiredTimers() {
        for (const thread of threads) {
            if (thread.wakeAtStep !== null && stepCount >= thread.wakeAtStep &&
                (thread.status === ThreadStatus.TIMED_WAITING || thread.status === ThreadStatus.JOINING)) {
                thread.wakeAtStep = null;
                if (thread.status === ThreadStatus.TIMED_WAITING && thread.blockedOn) {
                    // A timed monitor wait must re-acquire before continuing.
                    const monitor = thread.blockedOn;
                    const waiting = monitor.waitSet.indexOf(thread);
                    if (waiting >= 0) monitor.waitSet.splice(waiting, 1);
                    monitor.entryQueue.push(thread);
                    thread.status = ThreadStatus.BLOCKED;
                    admitNextOwner(monitor);
                    continue;
                }
                thread.blockedOn = null;
                thread.status = ThreadStatus.RUNNABLE;
            }
        }
    }

    function hasPendingTimer() {
        return threads.some(thread => thread.wakeAtStep !== null &&
            thread.status !== ThreadStatus.TERMINATED);
    }

    function earliestWakeStep() {
        let earliest = Infinity;
        for (const thread of threads) {
            if (thread.wakeAtStep !== null && thread.status !== ThreadStatus.TERMINATED) {
                earliest = Math.min(earliest, thread.wakeAtStep);
            }
        }
        return earliest;
    }

    /** Advance the clock while nothing can run; long gaps are skipped in one step. */
    function advanceIdleClock() {
        const gap = earliestWakeStep() - stepCount;
        stepCount += gap > MAX_PACED_IDLE_STEPS ? gap : 1;
    }

    // ── simulation clock ────────────────────────────────────────────────────

    /** Wall-clock time at program start plus the simulated time elapsed since. */
    function currentTimeMillis() {
        return clockOriginMillis + Math.round(stepCount / STEPS_PER_MILLISECOND);
    }

    /** The first step at which `currentTimeMillis()` reaches `epochMillis`. */
    function stepAtMillis(epochMillis) {
        return Math.ceil((epochMillis - clockOriginMillis) * STEPS_PER_MILLISECOND);
    }

    // ── java.util.Timer ─────────────────────────────────────────────────────
    //
    // Each Timer owns one worker thread, as in Java: its tasks run one after
    // another on that thread, so a long `run()` delays the next task. The
    // worker parks on the simulation clock between tasks, and it ends when its
    // queue is empty, so a program whose timers have nothing left to do can
    // finish (Java would keep a non-daemon timer thread alive forever).

    const TaskState = Object.freeze({
        VIRGIN: 'virgin', SCHEDULED: 'scheduled', EXECUTED: 'executed', CANCELLED: 'cancelled',
    });

    function timerRecordFor(timer) {
        let record = timers.get(timer);
        if (!record) {
            record = {
                name: timer.timerName || 'Timer-' + nextTimerSerial++,
                isDaemon: Boolean(timer.isDaemon),
                isCancelled: false,
                queue: [],
                thread: null,
            };
            timers.set(timer, record);
        }
        return record;
    }

    function taskRecordFor(task) {
        let record = timerTasks.get(task);
        if (!record) {
            record = {
                task,
                state: TaskState.VIRGIN,
                nextExecutionMillis: 0,
                periodMillis: 0,
                isFixedRate: false,
                lastScheduledMillis: 0,
            };
            timerTasks.set(task, record);
        }
        return record;
    }

    function wakeTimerWorker(record) {
        const worker = record.thread;
        if (worker && worker.status === ThreadStatus.TIMED_WAITING) {
            worker.wakeAtStep = null;
            worker.status = ThreadStatus.RUNNABLE;
        }
    }

    function* parkTimerWorker(thread, wakeAtStep) {
        thread.status = ThreadStatus.TIMED_WAITING;
        thread.blockedOn = null;
        thread.wakeAtStep = wakeAtStep;
        while (thread.status === ThreadStatus.TIMED_WAITING) {
            yield BLOCKED_YIELD;
        }
    }

    /** Cancelled tasks stay queued until they fall due or are purged, as in Java's TimerThread. */
    function nextDueTask(record) {
        return record.queue.reduce((earliest, task) =>
            earliest === null || task.nextExecutionMillis < earliest.nextExecutionMillis ? task : earliest, null);
    }

    /** Java computes the next execution *before* running the task, so a slow task can't drift a fixed-rate schedule. */
    function claimExecution(record, task, nowMillis) {
        task.lastScheduledMillis = task.nextExecutionMillis;
        if (task.periodMillis === 0) {
            task.state = TaskState.EXECUTED;
            record.queue.splice(record.queue.indexOf(task), 1);
            return;
        }
        task.nextExecutionMillis = task.isFixedRate
            ? task.nextExecutionMillis + task.periodMillis
            : nowMillis + task.periodMillis;
    }

    function* timerWorkerBody(record, state) {
        const thread = state.thread;
        try {
            while (!record.isCancelled) {
                const task = nextDueTask(record);
                if (!task) return;
                const nowMillis = currentTimeMillis();
                if (task.nextExecutionMillis > nowMillis) {
                    yield* parkTimerWorker(thread, stepAtMillis(task.nextExecutionMillis));
                    continue;
                }
                if (task.state !== TaskState.SCHEDULED) {
                    record.queue.splice(record.queue.indexOf(task), 1);
                    continue;
                }
                claimExecution(record, task, nowMillis);
                yield* invokeObjectMethodGen(task.task, 'run', [], state);
            }
        } catch (error) {
            // As in Java, an exception escaping a task kills the timer.
            record.isCancelled = true;
            record.queue = [];
            throw error;
        } finally {
            if (record.thread === thread) record.thread = null;
        }
    }

    function startTimerWorker(record) {
        if (liveThreads().length >= maxThreads) {
            throw schedulerError('Too many hamster threads (limit ' + maxThreads + ')');
        }
        const state = createNativeThreadState(programState, threadState => timerWorkerBody(record, threadState));
        const thread = makeThread(record.name, null, state);
        thread.daemon = record.isDaemon;
        state.thread = thread;
        threads.push(thread);
        record.thread = thread;
        thread.status = ThreadStatus.RUNNABLE;
        pendingEvents.push({ kind: 'started', threadId: thread.id, name: thread.name });
    }

    function hasPendingInput() {
        return threads.some(thread => thread.pendingInput !== null &&
            thread.status !== ThreadStatus.TERMINATED);
    }

    function isFinished() {
        return threads.every(thread =>
            thread.status === ThreadStatus.TERMINATED || thread.daemon);
    }

    function terminateDaemons() {
        for (const thread of threads) {
            if (thread.daemon && thread.status !== ThreadStatus.TERMINATED) {
                if (typeof thread.state.generator?.return === 'function') {
                    try { thread.state.generator.return(); } catch { /* already unwound */ }
                }
                terminate(thread, null);
            }
        }
    }

    function drainEvents() {
        const events = pendingEvents;
        pendingEvents = [];
        return events;
    }

    // ── deadlock reporting ──────────────────────────────────────────────────

    function describeWait(thread) {
        switch (thread.status) {
            case ThreadStatus.BLOCKED:
                return 'waiting to enter a synchronized section held by ' +
                    (thread.blockedOn?.owner?.name ?? 'another hamster');
            case ThreadStatus.WAITING: return 'suspended in wait(), nobody has signalled it';
            case ThreadStatus.TIMED_WAITING: return 'suspended in a timed wait';
            case ThreadStatus.JOINING: return 'waiting for ' + (thread.blockedOn?.name ?? 'another hamster');
            default: return thread.status;
        }
    }

    function deadlockReport() {
        const stuck = liveThreads();
        if (stuck.length === 0) return null;
        const lines = stuck.map(thread => `  - ${thread.name} (#${thread.id}): ${describeWait(thread)}`);
        return 'All hamsters are blocked:\n' + lines.join('\n');
    }

    function isDeadlocked() {
        return runnableThreads().length === 0 && !hasPendingTimer() &&
            !hasPendingInput() && liveThreads().length > 0;
    }

    // ── the scheduler object ────────────────────────────────────────────────

    const scheduler = {
        ThreadStatus,

        /** Registers the already-built main thread state as thread 1. */
        registerMain(mainState) {
            const thread = makeThread(MAIN_THREAD_NAME, null, mainState);
            thread.status = ThreadStatus.RUNNABLE;
            mainState.thread = thread;
            threads.push(thread);
            current = thread;
            pendingEvents.push({ kind: 'started', threadId: thread.id, name: thread.name });
            return thread;
        },

        currentThread() {
            return current;
        },

        threads() { return [...threads]; },
        liveThreads() { return liveThreads(); },
        current() { return current; },
        threadById(id) { return threads.find(thread => thread.id === Number(id)) || null; },
        isFinished,
        deadlockReport,
        isDeadlocked,
        stepCount() { return stepCount; },
        currentTimeMillis,

        reset() {
            threads.length = 0;
            nextThreadId = 1;
            current = null;
            stepCount = 0;
            pendingEvents = [];
            programState.monitors.clear();
            pendingSettings.clear();
            timers.clear();
            timerTasks.clear();
            nextTimerSerial = 0;
            clockOriginMillis = now();
        },

        /**
         * Advance at most one thread by at most one runner step, so the callers'
         * batching and speed pacing keep working unchanged.
         */
        step(opts) {
            wakeExpiredTimers();

            const thread = pick();
            if (!thread) {
                if (isFinished()) {
                    terminateDaemons();
                    return { status: 'finished', thread: null, instruction: null, events: drainEvents(), report: null };
                }
                if (hasPendingTimer()) {
                    // Nothing runnable but a timer is pending: let the clock advance.
                    advanceIdleClock();
                    return { status: 'progressed', thread: null, instruction: null, events: drainEvents(), report: null };
                }
                if (hasPendingInput()) {
                    const waiting = threads.find(t => t.pendingInput !== null && t.status !== ThreadStatus.TERMINATED);
                    return {
                        status: 'needsInput', thread: waiting, instruction: null,
                        events: drainEvents(), report: null, message: waiting.pendingInput.message,
                    };
                }
                return { status: 'deadlocked', thread: null, instruction: null, events: drainEvents(), report: deadlockReport() };
            }

            current = thread;
            thread.status = ThreadStatus.RUNNING;
            stepCount++;

            let progressed;
            try {
                progressed = executeRunnerStep(thread.state, opts);
            } catch (error) {
                if (error instanceof RunnerPause) {
                    thread.pendingInput = { message: error.message };
                    thread.status = ThreadStatus.RUNNABLE;
                    return {
                        status: 'needsInput', thread, instruction: thread.state.lastInstruction,
                        events: drainEvents(), report: null, message: error.message,
                    };
                }
                // An uncaught error kills only this thread (FR-008).
                terminate(thread, error);
                return {
                    status: 'progressed', thread, instruction: thread.state.lastInstruction,
                    events: drainEvents(), report: null,
                };
            }

            if (!progressed) {
                terminate(thread, null);
            } else if (thread.status === ThreadStatus.RUNNING) {
                thread.status = ThreadStatus.RUNNABLE;
            }

            if (isFinished()) terminateDaemons();

            return {
                status: isFinished() ? 'finished' : 'progressed',
                thread,
                instruction: thread.state.lastInstruction,
                events: drainEvents(),
                report: null,
            };
        },

        /** Resolves a thread parked on terminal input. */
        provideInput(thread) {
            const target = thread || threads.find(t => t.pendingInput !== null);
            if (target) target.pendingInput = null;
        },

        // ── thread operations called by the runner ──────────────────────────

        threadFor(object) {
            return threads.find(thread => thread.hamster === object) || null;
        },

        /** A `Thread.currentThread()` handle the program can call `getName()` on. */
        currentThreadHandle() {
            if (!current) return null;
            return current.hamster || { __kind: 'threadHandle', __threadId: current.id };
        },

        setPendingDaemon(object, value) { settingsFor(object).daemon = Boolean(value); },
        pendingDaemon(object) { return settingsFor(object).daemon; },

        setPendingPriority(object, priority, thread) {
            settingsFor(object).priority = priority;
            if (thread) thread.priority = priority;
        },
        pendingPriority(object) { return settingsFor(object).priority; },

        setThreadName(object, name, thread) {
            settingsFor(object).name = name;
            if (thread) thread.name = name;
        },
        pendingName(object, fallback) {
            return settingsFor(object).name || fallback || 'Hamster';
        },

        spawn(hamster, runMethod, name) {
            if (liveThreads().length >= maxThreads) {
                throw schedulerError('Too many hamster threads (limit ' + maxThreads + ')');
            }
            const state = createThreadState(programState, runMethod, hamster);
            const settings = settingsFor(hamster);
            const thread = makeThread(settings.name || name || 'Hamster', hamster, state);
            thread.daemon = settings.daemon;
            thread.priority = settings.priority;
            state.thread = thread;
            threads.push(thread);
            return thread;
        },

        start(thread) {
            if (thread.status !== ThreadStatus.NEW) {
                throw schedulerError('Hamster ' + thread.name + ' has already been started');
            }
            thread.status = ThreadStatus.RUNNABLE;
            pendingEvents.push({ kind: 'started', threadId: thread.id, name: thread.name });
        },

        *yieldNow() {
            yield BLOCKED_YIELD;
        },

        *sleep(milliseconds) {
            const thread = current;
            const steps = durationToSteps(milliseconds);
            if (steps === 0) {
                yield BLOCKED_YIELD;
                return;
            }
            thread.status = ThreadStatus.TIMED_WAITING;
            thread.blockedOn = null;
            thread.wakeAtStep = stepCount + steps;
            while (thread.status === ThreadStatus.TIMED_WAITING) {
                if (thread.interrupted) {
                    thread.interrupted = false;
                    thread.wakeAtStep = null;
                    thread.status = ThreadStatus.RUNNABLE;
                    throw interruptedError('sleep');
                }
                yield BLOCKED_YIELD;
            }
            if (thread.interrupted) {
                thread.interrupted = false;
                throw interruptedError('sleep');
            }
        },

        *join(target, milliseconds) {
            const thread = current;
            if (!target || target === thread) return;
            if (target.status === ThreadStatus.TERMINATED) return;
            thread.status = ThreadStatus.JOINING;
            thread.blockedOn = target;
            thread.wakeAtStep = milliseconds ? stepCount + durationToSteps(milliseconds) : null;
            while (thread.status === ThreadStatus.JOINING) {
                if (thread.interrupted) {
                    thread.interrupted = false;
                    thread.blockedOn = null;
                    thread.wakeAtStep = null;
                    thread.status = ThreadStatus.RUNNABLE;
                    throw interruptedError('join');
                }
                yield BLOCKED_YIELD;
            }
            if (thread.interrupted) {
                thread.interrupted = false;
                throw interruptedError('join');
            }
        },

        interrupt(target) {
            if (!target || target.status === ThreadStatus.TERMINATED) return;
            target.interrupted = true;
            // Wake it so it can observe the flag and throw.
            if (target.status === ThreadStatus.WAITING ||
                target.status === ThreadStatus.TIMED_WAITING ||
                target.status === ThreadStatus.JOINING) {
                if (target.status === ThreadStatus.WAITING && target.blockedOn) {
                    const monitor = target.blockedOn;
                    const index = monitor.waitSet.indexOf(target);
                    if (index >= 0) monitor.waitSet.splice(index, 1);
                }
                target.blockedOn = null;
                target.wakeAtStep = null;
                target.status = ThreadStatus.RUNNABLE;
            }
        },

        isInterrupted(target) {
            return Boolean(target && target.interrupted);
        },

        /** Reads *and clears* the current thread's flag, matching `Thread.interrupted()`. */
        consumeInterrupted() {
            if (!current) return false;
            const was = current.interrupted;
            current.interrupted = false;
            return was;
        },

        stopThread(target) {
            if (!target || target.status === ThreadStatus.TERMINATED) return;
            if (typeof target.state.generator?.return === 'function') {
                try { target.state.generator.return(); } catch { /* already unwound */ }
            }
            terminate(target, null);
        },

        // ── monitors ────────────────────────────────────────────────────────

        *enterMonitor(lock) {
            const thread = current;
            const monitor = monitorFor(lock);
            if (monitor.owner === null) {
                acquire(monitor, thread, 1);
                return;
            }
            if (monitor.owner === thread) {
                monitor.depth += 1;   // re-entrant
                return;
            }
            thread.pendingReentryDepth = 1;
            thread.status = ThreadStatus.BLOCKED;
            thread.blockedOn = monitor;
            monitor.entryQueue.push(thread);
            while (thread.status === ThreadStatus.BLOCKED) {
                yield BLOCKED_YIELD;
            }
            // `admitNextOwner` already handed the monitor to this thread.
        },

        exitMonitor(lock) {
            const thread = current;
            const monitor = programState.monitors.get(lock);
            if (!monitor || monitor.owner !== thread) return;
            monitor.depth -= 1;
            if (monitor.depth === 0) {
                monitor.owner = null;
                const index = thread.monitorsHeld.indexOf(monitor);
                if (index >= 0) thread.monitorsHeld.splice(index, 1);
                admitNextOwner(monitor);
            }
        },

        *monitorWait(lock, milliseconds) {
            const thread = current;
            const monitor = programState.monitors.get(lock);
            if (!monitor || monitor.owner !== thread) {
                throw schedulerError('wait requires the monitor of the object (use synchronized)');
            }
            // The full re-entrancy depth is restored on wake, so a thread that
            // entered three times still holds it three times afterwards.
            thread.pendingReentryDepth = releaseFully(monitor, thread);
            thread.status = ThreadStatus.WAITING;
            thread.blockedOn = monitor;
            monitor.waitSet.push(thread);
            if (milliseconds) {
                thread.status = ThreadStatus.TIMED_WAITING;
                thread.wakeAtStep = stepCount + durationToSteps(milliseconds);
            }

            let interrupted = false;
            while (thread.status === ThreadStatus.WAITING || thread.status === ThreadStatus.TIMED_WAITING) {
                if (thread.interrupted) {
                    thread.interrupted = false;
                    interrupted = true;
                    const index = monitor.waitSet.indexOf(thread);
                    if (index >= 0) monitor.waitSet.splice(index, 1);
                    thread.wakeAtStep = null;
                    thread.blockedOn = monitor;
                    thread.status = ThreadStatus.BLOCKED;
                    monitor.entryQueue.push(thread);
                    admitNextOwner(monitor);
                    break;
                }
                yield BLOCKED_YIELD;
            }

            // Signalled or interrupted: re-acquire before continuing (FR-022).
            while (thread.status === ThreadStatus.BLOCKED) {
                yield BLOCKED_YIELD;
            }
            thread.blockedOn = null;
            if (interrupted) throw interruptedError('wait');
        },

        monitorNotify(lock, all) {
            const thread = current;
            const monitor = programState.monitors.get(lock);
            if (!monitor || monitor.owner !== thread) {
                throw schedulerError((all ? 'notifyAll' : 'notify') +
                    ' requires the monitor of the object (use synchronized)');
            }
            const waking = all ? monitor.waitSet.splice(0) : monitor.waitSet.splice(0, 1);
            for (const woken of waking) {
                woken.wakeAtStep = null;
                woken.status = ThreadStatus.BLOCKED;
                woken.blockedOn = monitor;
                monitor.entryQueue.push(woken);
            }
        },

        monitorFor,

        // ── java.util.Timer / TimerTask, called by the runner ───────────────

        /**
         * @param {number} firstExecutionMillis absolute epoch time of the first run
         * @param {number} periodMillis 0 for a one-shot task
         */
        scheduleTimerTask(timer, task, firstExecutionMillis, periodMillis, isFixedRate) {
            const record = timerRecordFor(timer);
            if (record.isCancelled) throw javaException('IllegalStateException', 'Timer already cancelled.');
            const taskRecord = taskRecordFor(task);
            if (taskRecord.state !== TaskState.VIRGIN) {
                throw javaException('IllegalStateException', 'Task already scheduled or cancelled');
            }
            taskRecord.state = TaskState.SCHEDULED;
            taskRecord.nextExecutionMillis = firstExecutionMillis;
            taskRecord.periodMillis = periodMillis;
            taskRecord.isFixedRate = isFixedRate;
            record.queue.push(taskRecord);
            if (record.thread) {
                wakeTimerWorker(record);
            } else {
                startTimerWorker(record);
            }
        },

        /** Discards every scheduled task; a task that is running finishes first. */
        cancelTimer(timer) {
            const record = timerRecordFor(timer);
            record.isCancelled = true;
            record.queue = [];
            wakeTimerWorker(record);
        },

        purgeTimer(timer) {
            const record = timerRecordFor(timer);
            const before = record.queue.length;
            record.queue = record.queue.filter(task => task.state !== TaskState.CANCELLED);
            return before - record.queue.length;
        },

        /** True when cancelling prevented at least one future run, as in `TimerTask.cancel()`. */
        cancelTimerTask(task) {
            const record = taskRecordFor(task);
            const preventedRun = record.state === TaskState.SCHEDULED;
            record.state = TaskState.CANCELLED;
            return preventedRun;
        },

        timerTaskScheduledExecutionTime(task) {
            return timerTasks.get(task)?.lastScheduledMillis ?? 0;
        },
    };

    programState.scheduler = scheduler;
    return scheduler;
}
