/**
 * Debugger controller for the simulator webview: breakpoints, step/continue/
 * stepIn/stepOut/pause, and stack/scopes/variables/evaluate requests driven
 * by `dbg:*` messages from the extension host (see `../../hamsterDebugSession.ts`
 * and `../../webviewProtocol.ts`). The runner itself lives in the bundled
 * `dist/webview/hamster-lang.js` (lexer/parser/runner); this module only
 * drives it step-by-step and reports progress back to the host.
 */

const DEBUG_STEP_BATCH_SIZE = 100;
const DEBUG_STEP_TIME_SLICE_MS = 8;

/**
 * Frame ids and variable references must be unique across threads, because the
 * `scopes`/`variables`/`evaluate` requests carry no thread of their own.
 *
 *   frameId  = threadId * FRAME_ID_STRIDE + frameIndex + 1
 *   localsRef = LOCALS_BASE + frameId
 *
 * The stride caps a thread at 999 frames, well above the runner's own call
 * depth limit of 256. Globals keep the literal reference 1: there is exactly
 * one globals scope and every thread shares it.
 */
const FRAME_ID_STRIDE = 1000;
const LOCALS_BASE = 1000000;
const GLOBALS_VARIABLES_REFERENCE = 1;
const MAIN_THREAD_ID = 1;

function encodeFrameId(threadId, frameIndex) {
    return threadId * FRAME_ID_STRIDE + frameIndex + 1;
}

function decodeFrameId(frameId) {
    const id = Number(frameId) | 0;
    return { threadId: Math.floor(id / FRAME_ID_STRIDE), frameIndex: (id % FRAME_ID_STRIDE) - 1 };
}

function dbgFormatValue(v) {
    if (v === null || v === undefined) return String(v);
    if (typeof v === 'object') {
        if (v.__kind === 'hamster') return 'Hamster #' + v.id;
        if (v.__kind === 'class' || v.__kind === 'classLiteral') return 'class ' + (v.name || '');
        if (v.__kind === 'enum') return v.__className + '.' + v.name;
        try { return JSON.stringify(v); } catch (e) { return String(v); }
    }
    if (typeof v === 'string') return JSON.stringify(v);
    return String(v);
}

/**
 * @param {object} deps
 * @param {Window['acquireVsCodeApi'] extends () => infer T ? T : never} deps.vscodeApi
 * @param {object} deps.engine simulator built-in API (start/reset)
 * @param {() => void} deps.render re-renders the canvas from current engine state
 * @param {() => object} deps.getEngineState live engine state (for log flushing)
 * @param {() => object | null} deps.getRunnerState
 * @param {(state: object | null) => void} deps.setRunnerState
 * @param {() => boolean} deps.compileProgram compiles `currentSource`; returns success
 * @param {(text: string) => void} deps.appendLog
 * @param {(status: string) => void} deps.setStatus
 * @param {(prompt: string, resume: () => void) => void} deps.requestTerminalInput
 * @param {() => void} deps.cancelTerminalInput
 */
export function createDebuggerController({
    vscodeApi, engine, render, getEngineState, getRunnerState, setRunnerState,
    compileProgram, appendLog, setStatus, requestTerminalInput, cancelTerminalInput,
    stopRunLoop, clearLog, setCurrentSource, getSpeedMs,
}) {
    let dbgActive = false;
    let dbgRunning = false;
    let dbgBreakpoints = new Set();
    let dbgTimerId = null;
    let dbgOperationId = 0;
    /** Thread ids already announced to the host, so each is reported once. */
    let announcedThreads = new Set();

    function scheduler() {
        const runnerState = getRunnerState();
        return runnerState && runnerState.programState
            ? runnerState.programState.scheduler
            : null;
    }

    /** The runner state of one thread, falling back to the main state. */
    function threadStateFor(threadId) {
        const thread = scheduler()?.threadById(threadId);
        return thread ? thread.state : null;
    }

    function threadDetail(thread) {
        const blocked = thread.blockedOn;
        switch (thread.status) {
            case 'blocked': return 'waiting to enter a synchronized section';
            case 'waiting': return 'suspended in wait()';
            case 'timedWaiting': return 'in a timed wait';
            case 'joining': return 'waiting for ' + (blocked?.name || 'another hamster');
            default: return undefined;
        }
    }

    /** Announce threads that started or finished since the last report. */
    function publishThreadEvents(events) {
        for (const event of events || []) {
            if (event.kind === 'started' && !announcedThreads.has(event.threadId)) {
                announcedThreads.add(event.threadId);
                vscodeApi.postMessage({
                    type: 'dbg:threadStarted', threadId: event.threadId, name: event.name,
                });
            } else if (event.kind === 'exited' && announcedThreads.has(event.threadId)) {
                announcedThreads.delete(event.threadId);
                vscodeApi.postMessage({ type: 'dbg:threadExited', threadId: event.threadId });
            } else if (event.kind === 'error') {
                const message = 'Runtime error in ' + event.name + ': ' +
                    (event.error?.message || event.error);
                appendLog(message, true);
                vscodeApi.postMessage({
                    type: 'dbg:output', category: 'stderr', output: message + '\n',
                    threadId: event.threadId,
                });
            }
        }
    }

    function sendThreads(requestId) {
        const live = scheduler()?.liveThreads() || [];
        vscodeApi.postMessage({
            type: 'dbg:threads',
            requestId,
            threads: live.map(thread => ({
                id: thread.id,
                name: thread.name,
                status: thread.status,
                detail: threadDetail(thread),
            })),
        });
    }

    function dbgClearTimer() {
        if (dbgTimerId !== null) { clearTimeout(dbgTimerId); dbgTimerId = null; }
    }

    function dbgStartOperation() {
        dbgOperationId++;
        dbgClearTimer();
        cancelTerminalInput();
        return dbgOperationId;
    }

    function dbgCancelOperation() {
        dbgOperationId++;
        dbgRunning = false;
        dbgClearTimer();
        cancelTerminalInput();
    }

    function dbgFlushNewLogs() {
        const engineState = getEngineState();
        if (!engineState || !engineState.log) return;
        if (typeof engineState._shownLogCount !== 'number') engineState._shownLogCount = 0;
        while (engineState._shownLogCount < engineState.log.length) {
            appendLog(engineState.log[engineState._shownLogCount]);
            engineState._shownLogCount++;
        }
    }

    function dbgFrameDepth(threadId) {
        const state = threadId != null ? threadStateFor(threadId) : getRunnerState();
        return state && Array.isArray(state.frames) ? state.frames.length : 0;
    }

    function dbgIsAtCallSite(threadId) {
        const state = threadId != null ? threadStateFor(threadId) : getRunnerState();
        return Boolean(state && state.lastInstruction && state.lastInstruction.kind === 'call');
    }

    function launch(msg) {
        dbgCancelOperation();
        dbgActive = true;
        dbgBreakpoints = new Set((msg.breakpoints || []).map(n => n | 0));
        stopRunLoop();
        setRunnerState(null);
        engine.reset();
        clearLog();
        if (typeof msg.source === 'string') setCurrentSource(msg.source);
        if (!compileProgram()) {
            vscodeApi.postMessage({ type: 'dbg:terminated' });
            dbgActive = false;
            return;
        }
        engine.start();
        announcedThreads = new Set([MAIN_THREAD_ID]);
        setStatus('Debugging');
        if (msg.stopOnEntry === false) {
            continueRun();
        } else {
            // Step once so we have a real lastInstruction location, then stop.
            stepIn('entry');
        }
    }

    function setBreakpoints(lines) {
        dbgBreakpoints = new Set(lines.map(n => n | 0));
    }

    /**
     * `stepThreadId` is the thread the user selected: only its progress can
     * satisfy `shouldStop`. A breakpoint hit in *any* thread still stops the
     * whole program, because execution is cooperative and a stop-the-world
     * snapshot is consistent across every hamster.
     */
    function stepUntil(reason, shouldStop, stepThreadId) {
        if (!dbgActive) return;
        const activeScheduler = scheduler();
        if (!activeScheduler || activeScheduler.isFinished()) {
            terminate();
            return;
        }
        const operationId = dbgStartOperation();
        const startingState = threadStateFor(stepThreadId) || getRunnerState();
        const startingLoc = startingState?.lastInstruction?.loc;
        const startingLine = startingLoc ? startingLoc.line : null;
        let hasLeftStartingLine = false;
        dbgRunning = true;

        function stop(stopReason, loc, threadId, text) {
            dbgRunning = false;
            render();
            dbgFlushNewLogs();
            vscodeApi.postMessage({
                type: 'dbg:stopped',
                reason: stopReason,
                threadId: threadId || stepThreadId || MAIN_THREAD_ID,
                line: loc ? loc.line : 1,
                column: loc ? loc.column : 1,
                ...(text ? { text } : {}),
            });
        }

        function advance() {
            if (!dbgRunning || !dbgActive || operationId !== dbgOperationId) return;
            try {
                const batchStartedAt = performance.now();
                let batchSize = 0;
                let shouldRender = false;
                while (batchSize < DEBUG_STEP_BATCH_SIZE &&
                       performance.now() - batchStartedAt < DEBUG_STEP_TIME_SLICE_MS) {
                    const result = activeScheduler.step({ granularity: 'statement' });
                    publishThreadEvents(result.events);
                    const instruction = result.instruction || {};
                    const loc = instruction.loc;
                    const actingThreadId = result.thread ? result.thread.id : null;
                    batchSize++;
                    shouldRender ||= instruction.kind === 'instruction';
                    if (loc && (startingLine === null || loc.line !== startingLine)) {
                        hasLeftStartingLine = true;
                    }

                    if (result.status === 'finished') {
                        render();
                        dbgFlushNewLogs();
                        terminate();
                        return;
                    }
                    if (result.status === 'deadlocked') {
                        const report = result.report || 'All hamsters are blocked';
                        appendLog(report, true);
                        vscodeApi.postMessage({
                            type: 'dbg:output', category: 'stderr', output: report + '\n',
                        });
                        stop('exception', loc, actingThreadId, report);
                        return;
                    }
                    if (result.status === 'needsInput') {
                        dbgRunning = false;
                        requestTerminalInput(result.message, () => {
                            if (!dbgActive || operationId !== dbgOperationId) return;
                            dbgRunning = true;
                            advance();
                        });
                        return;
                    }
                    if (loc && hasLeftStartingLine && dbgBreakpoints.has(loc.line)) {
                        stop('breakpoint', loc, actingThreadId);
                        return;
                    }
                    // Only the selected thread's own progress ends the step.
                    if (actingThreadId === stepThreadId && shouldStop()) {
                        stop(reason, loc, actingThreadId);
                        return;
                    }
                }
                if (shouldRender) {
                    render();
                    dbgFlushNewLogs();
                }
                dbgTimerId = setTimeout(advance, 0);
            } catch (e) {
                const m = 'Runtime error: ' + (e.message || e);
                appendLog(m, true);
                vscodeApi.postMessage({ type: 'dbg:output', category: 'stderr', output: m + '\n' });
                vscodeApi.postMessage({
                    type: 'dbg:stopped', reason: 'exception',
                    threadId: stepThreadId || MAIN_THREAD_ID, text: m,
                });
                dbgRunning = false;
            }
        }

        advance();
    }

    function resolveStepThread(threadId) {
        const id = Number(threadId);
        if (Number.isInteger(id) && scheduler()?.threadById(id)) return id;
        return scheduler()?.current()?.id || MAIN_THREAD_ID;
    }

    function stepIn(reason = 'step', threadId) {
        const target = resolveStepThread(threadId);
        const startingDepth = dbgFrameDepth(target);
        stepUntil(reason,
            () => dbgFrameDepth(target) > startingDepth || !dbgIsAtCallSite(target), target);
    }

    function next(threadId) {
        const target = resolveStepThread(threadId);
        const startingDepth = dbgFrameDepth(target);
        stepUntil('step',
            () => dbgFrameDepth(target) <= startingDepth && !dbgIsAtCallSite(target), target);
    }

    function stepOut(threadId) {
        const target = resolveStepThread(threadId);
        const startingDepth = dbgFrameDepth(target);
        // A spawned hamster's root frame is its `run()`, not `main`, so stepping
        // out of the bottom frame means letting the program continue.
        if (startingDepth <= 1) {
            continueRun();
            return;
        }
        stepUntil('step', () => dbgFrameDepth(target) < startingDepth, target);
    }

    function continueRun() {
        if (!dbgActive) return;
        const operationId = dbgStartOperation();
        dbgRunning = true;
        function tick() {
            if (!dbgRunning || !dbgActive || operationId !== dbgOperationId) return;
            const activeScheduler = scheduler();
            if (!activeScheduler || activeScheduler.isFinished()) { terminate(); return; }
            try {
                const result = activeScheduler.step({ granularity: 'statement' });
                publishThreadEvents(result.events);
                const inst = result.instruction || {};
                const isHamster = inst.kind === 'instruction';
                const actingThreadId = result.thread ? result.thread.id : MAIN_THREAD_ID;
                if (isHamster) {
                    render();
                    dbgFlushNewLogs();
                }
                if (result.status === 'finished') { render(); dbgFlushNewLogs(); terminate(); return; }
                if (result.status === 'deadlocked') {
                    const report = result.report || 'All hamsters are blocked';
                    dbgRunning = false;
                    render();
                    dbgFlushNewLogs();
                    appendLog(report, true);
                    vscodeApi.postMessage({
                        type: 'dbg:output', category: 'stderr', output: report + '\n',
                    });
                    vscodeApi.postMessage({
                        type: 'dbg:stopped', reason: 'exception',
                        threadId: actingThreadId, text: report,
                    });
                    return;
                }
                if (result.status === 'needsInput') {
                    dbgRunning = false;
                    requestTerminalInput(result.message, () => {
                        if (!dbgActive || operationId !== dbgOperationId) return;
                        dbgRunning = true;
                        tick();
                    });
                    return;
                }
                const loc = inst.loc;
                if (loc && dbgBreakpoints.has(loc.line)) {
                    dbgRunning = false;
                    render();
                    dbgFlushNewLogs();
                    vscodeApi.postMessage({
                        type: 'dbg:stopped', reason: 'breakpoint',
                        threadId: actingThreadId, line: loc.line, column: loc.column,
                    });
                    return;
                }
                // Pace the visualisation: full speed between hamster
                // instructions, near-zero delay for pure statements.
                const delay = isHamster ? (getSpeedMs() || 0) : 0;
                dbgTimerId = setTimeout(tick, delay);
            } catch (e) {
                const m = 'Runtime error: ' + (e.message || e);
                appendLog(m, true);
                vscodeApi.postMessage({ type: 'dbg:output', category: 'stderr', output: m + '\n' });
                vscodeApi.postMessage({
                    type: 'dbg:stopped', reason: 'exception',
                    threadId: MAIN_THREAD_ID, text: m,
                });
                dbgRunning = false;
            }
        }
        tick();
    }

    function pause() {
        dbgCancelOperation();
        const thread = scheduler()?.current();
        const state = thread ? thread.state : getRunnerState();
        const loc = state && state.lastInstruction && state.lastInstruction.loc;
        vscodeApi.postMessage({
            type: 'dbg:stopped', reason: 'pause',
            threadId: thread ? thread.id : MAIN_THREAD_ID,
            line: loc ? loc.line : 1, column: loc ? loc.column : 1,
        });
    }

    function terminate() {
        dbgCancelOperation();
        vscodeApi.postMessage({ type: 'dbg:terminated' });
        vscodeApi.postMessage({ type: 'clearHighlight' });
        setStatus('Debug session ended');
    }

    function disconnect() {
        dbgActive = false;
        dbgCancelOperation();
        vscodeApi.postMessage({ type: 'clearHighlight' });
    }

    function sendStackTrace(requestId, threadId) {
        const frames = [];
        const id = Number(threadId) || MAIN_THREAD_ID;
        const state = threadStateFor(id);
        if (state && Array.isArray(state.frames) && state.frames.length > 0) {
            const top = state.frames.length - 1;
            const topLoc = state.lastInstruction && state.lastInstruction.loc;
            for (let i = top; i >= 0; i--) {
                const f = state.frames[i];
                let line = 1, column = 1;
                if (i === top) {
                    line = topLoc ? topLoc.line : (f.loc ? f.loc.line : 1);
                    column = topLoc ? topLoc.column : (f.loc ? f.loc.column : 1);
                } else {
                    const cl = state.frames[i + 1] && state.frames[i + 1].callerLoc;
                    line = cl ? cl.line : (f.loc ? f.loc.line : 1);
                    column = cl ? cl.column : (f.loc ? f.loc.column : 1);
                }
                frames.push({
                    id: encodeFrameId(id, i), name: f.name || '<anonymous>', line, column,
                });
            }
        }
        vscodeApi.postMessage({ type: 'dbg:stackTrace', requestId, threadId: id, frames });
    }

    function sendScopes(requestId, frameId) {
        const scopes = [
            { name: 'Locals', variablesReference: LOCALS_BASE + (frameId | 0), expensive: false },
            { name: 'Globals', variablesReference: GLOBALS_VARIABLES_REFERENCE, expensive: false },
        ];
        vscodeApi.postMessage({ type: 'dbg:scopes', requestId, scopes });
    }

    function sendVariables(requestId, variablesReference) {
        const vars = [];
        const push = (name, value) =>
            vars.push({ name, value: dbgFormatValue(value), variablesReference: 0 });

        if (variablesReference === GLOBALS_VARIABLES_REFERENCE) {
            // One globals scope, shared by every thread.
            const root = getRunnerState()?.scopes?.[0];
            if (root && typeof root.forEach === 'function') root.forEach((v, k) => push(k, v));
        } else if (variablesReference >= LOCALS_BASE) {
            const { threadId, frameIndex } = decodeFrameId(variablesReference - LOCALS_BASE);
            const state = threadStateFor(threadId);
            const frames = state?.frames || [];
            const frame = frames[frameIndex];
            if (frame && Array.isArray(state.scopes)) {
                const start = frame.scopeIndex | 0;
                const nextFrame = frames[frameIndex + 1];
                const end = nextFrame ? (nextFrame.scopeIndex | 0) : state.scopes.length;
                const seen = new Set();
                for (let i = end - 1; i >= start; i--) {
                    const scope = state.scopes[i];
                    if (scope && typeof scope.forEach === 'function') {
                        scope.forEach((v, k) => {
                            if (!seen.has(k)) { seen.add(k); push(k, v); }
                        });
                    }
                }
            }
        }
        vscodeApi.postMessage({ type: 'dbg:variables', requestId, variables: vars });
    }

    function evaluate(requestId, expression, frameId) {
        try {
            // The frame id names its own thread, so evaluation always resolves
            // against the selected hamster's frame, never a global one.
            const { threadId, frameIndex } = frameId != null
                ? decodeFrameId(frameId)
                : { threadId: scheduler()?.current()?.id || MAIN_THREAD_ID, frameIndex: null };
            const state = threadStateFor(threadId) || getRunnerState();
            if (!state) {
                throw new Error('No program is currently paused');
            }
            const expr = parseExpression(String(expression || '').trim());
            const value = evaluateExpression(
                expr, state, frameIndex == null ? undefined : frameIndex + 1
            );
            vscodeApi.postMessage({ type: 'dbg:evaluate', requestId, result: dbgFormatValue(value) });
        } catch (error) {
            vscodeApi.postMessage({ type: 'dbg:evaluate', requestId, error: error && error.message ? error.message : String(error) });
        }
    }

    return {
        launch, setBreakpoints, continueRun, next, stepIn, stepOut, pause,
        sendStackTrace, sendScopes, sendVariables, sendThreads, evaluate, disconnect,
    };
}
