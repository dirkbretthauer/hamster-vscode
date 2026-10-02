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

function dbgFormatValue(v) {
    if (v === null || v === undefined) return String(v);
    if (typeof v === 'object') {
        if (v.__kind === 'hamster') return 'Hamster #' + v.id;
        if (v.__kind === 'class') return 'class ' + (v.name || '');
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

    function dbgFrameDepth() {
        const runnerState = getRunnerState();
        return runnerState && Array.isArray(runnerState.frames) ? runnerState.frames.length : 0;
    }

    function dbgIsAtCallSite() {
        const runnerState = getRunnerState();
        return runnerState && runnerState.lastInstruction && runnerState.lastInstruction.kind === 'call';
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

    function stepUntil(reason, shouldStop) {
        if (!dbgActive) return;
        const runnerStateAtStart = getRunnerState();
        if (!runnerStateAtStart || runnerStateAtStart.finished) {
            terminate();
            return;
        }
        const operationId = dbgStartOperation();
        const startingLoc = runnerStateAtStart.lastInstruction && runnerStateAtStart.lastInstruction.loc;
        const startingLine = startingLoc ? startingLoc.line : null;
        let hasLeftStartingLine = false;
        dbgRunning = true;

        function stop(stopReason, loc) {
            dbgRunning = false;
            render();
            dbgFlushNewLogs();
            vscodeApi.postMessage({
                type: 'dbg:stopped',
                reason: stopReason,
                line: loc ? loc.line : 1,
                column: loc ? loc.column : 1,
            });
        }

        function advance() {
            if (!dbgRunning || !dbgActive || operationId !== dbgOperationId) return;
            const runnerState = getRunnerState();
            try {
                const batchStartedAt = performance.now();
                let batchSize = 0;
                let shouldRender = false;
                while (batchSize < DEBUG_STEP_BATCH_SIZE &&
                       performance.now() - batchStartedAt < DEBUG_STEP_TIME_SLICE_MS) {
                    const hasMore = window.executeRunnerStep(runnerState, { granularity: 'statement' });
                    const instruction = runnerState.lastInstruction || {};
                    const loc = instruction.loc;
                    batchSize++;
                    shouldRender ||= instruction.kind === 'instruction';
                    if (loc && (startingLine === null || loc.line !== startingLine)) {
                        hasLeftStartingLine = true;
                    }
                    if (!hasMore) {
                        render();
                        dbgFlushNewLogs();
                        terminate();
                        return;
                    }
                    if (loc && hasLeftStartingLine && dbgBreakpoints.has(loc.line)) {
                        stop('breakpoint', loc);
                        return;
                    }
                    if (shouldStop()) {
                        stop(reason, loc);
                        return;
                    }
                }
                if (shouldRender) {
                    render();
                    dbgFlushNewLogs();
                }
                dbgTimerId = setTimeout(advance, 0);
            } catch (e) {
                if (window.RunnerPause && e instanceof window.RunnerPause) {
                    dbgRunning = false;
                    requestTerminalInput(e.message, () => {
                        if (!dbgActive || operationId !== dbgOperationId) return;
                        dbgRunning = true;
                        advance();
                    });
                    return;
                }
                const m = 'Runtime error: ' + (e.message || e);
                appendLog(m, true);
                vscodeApi.postMessage({ type: 'dbg:output', category: 'stderr', output: m + '\n' });
                vscodeApi.postMessage({ type: 'dbg:stopped', reason: 'exception', text: m });
                dbgRunning = false;
            }
        }

        advance();
    }

    function stepIn(reason = 'step') {
        const startingDepth = dbgFrameDepth();
        stepUntil(reason, () => dbgFrameDepth() > startingDepth || !dbgIsAtCallSite());
    }

    function next() {
        const startingDepth = dbgFrameDepth();
        stepUntil('step', () => dbgFrameDepth() <= startingDepth && !dbgIsAtCallSite());
    }

    function stepOut() {
        const startingDepth = dbgFrameDepth();
        if (startingDepth <= 1) {
            continueRun();
            return;
        }
        stepUntil('step', () => dbgFrameDepth() < startingDepth);
    }

    function continueRun() {
        if (!dbgActive) return;
        const operationId = dbgStartOperation();
        dbgRunning = true;
        function tick() {
            if (!dbgRunning || !dbgActive || operationId !== dbgOperationId) return;
            const runnerState = getRunnerState();
            if (!runnerState || runnerState.finished) { terminate(); return; }
            try {
                const hasMore = window.executeRunnerStep(runnerState, { granularity: 'statement' });
                const inst = runnerState.lastInstruction || {};
                const isHamster = inst.kind === 'instruction';
                if (isHamster) {
                    render();
                    dbgFlushNewLogs();
                }
                if (!hasMore) { render(); dbgFlushNewLogs(); terminate(); return; }
                const loc = inst.loc;
                if (loc && dbgBreakpoints.has(loc.line)) {
                    dbgRunning = false;
                    render();
                    dbgFlushNewLogs();
                    vscodeApi.postMessage({ type: 'dbg:stopped', reason: 'breakpoint', line: loc.line, column: loc.column });
                    return;
                }
                // Pace the visualisation: full speed between hamster
                // instructions, near-zero delay for pure statements.
                const delay = isHamster ? (getSpeedMs() || 0) : 0;
                dbgTimerId = setTimeout(tick, delay);
            } catch (e) {
                if (window.RunnerPause && e instanceof window.RunnerPause) {
                    dbgRunning = false;
                    requestTerminalInput(e.message, () => {
                        if (!dbgActive || operationId !== dbgOperationId) return;
                        dbgRunning = true;
                        tick();
                    });
                    return;
                }
                const m = 'Runtime error: ' + (e.message || e);
                appendLog(m, true);
                vscodeApi.postMessage({ type: 'dbg:output', category: 'stderr', output: m + '\n' });
                vscodeApi.postMessage({ type: 'dbg:stopped', reason: 'exception', text: m });
                dbgRunning = false;
            }
        }
        tick();
    }

    function pause() {
        dbgCancelOperation();
        const runnerState = getRunnerState();
        const loc = runnerState && runnerState.lastInstruction && runnerState.lastInstruction.loc;
        vscodeApi.postMessage({ type: 'dbg:stopped', reason: 'pause', line: loc ? loc.line : 1, column: loc ? loc.column : 1 });
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

    function sendStackTrace(requestId) {
        const frames = [];
        const runnerState = getRunnerState();
        if (runnerState && Array.isArray(runnerState.frames) && runnerState.frames.length > 0) {
            const top = runnerState.frames.length - 1;
            const topLoc = runnerState.lastInstruction && runnerState.lastInstruction.loc;
            for (let i = top; i >= 0; i--) {
                const f = runnerState.frames[i];
                let line = 1, column = 1;
                if (i === top) {
                    line = topLoc ? topLoc.line : (f.loc ? f.loc.line : 1);
                    column = topLoc ? topLoc.column : (f.loc ? f.loc.column : 1);
                } else {
                    const cl = runnerState.frames[i + 1] && runnerState.frames[i + 1].callerLoc;
                    line = cl ? cl.line : (f.loc ? f.loc.line : 1);
                    column = cl ? cl.column : (f.loc ? f.loc.column : 1);
                }
                frames.push({ id: i + 1, name: f.name || '<anonymous>', line, column });
            }
        }
        vscodeApi.postMessage({ type: 'dbg:stackTrace', requestId, frames });
    }

    function sendScopes(requestId, frameId) {
        const scopes = [
            { name: 'Locals', variablesReference: 1000 + (frameId | 0), expensive: false },
            { name: 'Globals', variablesReference: 1, expensive: false },
        ];
        vscodeApi.postMessage({ type: 'dbg:scopes', requestId, scopes });
    }

    function sendVariables(requestId, variablesReference) {
        const vars = [];
        const runnerState = getRunnerState();
        if (runnerState && Array.isArray(runnerState.scopes)) {
            if (variablesReference === 1) {
                const root = runnerState.scopes[0];
                if (root && typeof root.forEach === 'function') {
                    root.forEach((v, k) => vars.push({ name: k, value: dbgFormatValue(v), variablesReference: 0 }));
                }
            } else if (variablesReference >= 1000) {
                const frameId = variablesReference - 1000;
                const idx = frameId - 1;
                const frames = runnerState.frames || [];
                const frame = frames[idx];
                if (frame) {
                    const start = frame.scopeIndex | 0;
                    const nextFrame = frames[idx + 1];
                    const end = nextFrame ? (nextFrame.scopeIndex | 0) : runnerState.scopes.length;
                    const seen = new Set();
                    for (let i = end - 1; i >= start; i--) {
                        const scope = runnerState.scopes[i];
                        if (scope && typeof scope.forEach === 'function') {
                            scope.forEach((v, k) => {
                                if (!seen.has(k)) {
                                    seen.add(k);
                                    vars.push({ name: k, value: dbgFormatValue(v), variablesReference: 0 });
                                }
                            });
                        }
                    }
                }
            }
        }
        vscodeApi.postMessage({ type: 'dbg:variables', requestId, variables: vars });
    }

    function evaluate(requestId, expression, frameId) {
        try {
            const runnerState = getRunnerState();
            if (!runnerState) {
                throw new Error('No program is currently paused');
            }
            const expr = parseExpression(String(expression || '').trim());
            const value = evaluateExpression(expr, runnerState, frameId);
            vscodeApi.postMessage({ type: 'dbg:evaluate', requestId, result: dbgFormatValue(value) });
        } catch (error) {
            vscodeApi.postMessage({ type: 'dbg:evaluate', requestId, error: error && error.message ? error.message : String(error) });
        }
    }

    return {
        launch, setBreakpoints, continueRun, next, stepIn, stepOut, pause,
        sendStackTrace, sendScopes, sendVariables, evaluate, disconnect,
    };
}
