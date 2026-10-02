/**
 * UI bootstrap and event wiring for the simulator webview: DOM lookups,
 * toolbar buttons, terrain-edit tool handlers, terminal input, zoom/speed
 * controls, and the `window.addEventListener('message', ...)` dispatch from
 * the extension host (`../../hamsterPanel.ts`). Delegates to the engine,
 * runtime adapter, renderer, and debugger controller modules for everything
 * else.
 */
import { createSimulatorEngine } from './engine.js';
import { createHamsterRuntime } from './runtime.js';
import { createSimulatorRenderer, DEFAULT_CELL_SIZE, ZOOM_STEP } from './renderer.js';
import { createDebuggerController } from './debugger.js';
import { eventToCell, updateHoverText, readCornAmount } from '../shared/terrainHitTest.js';

export function bootstrap() {
    const vscodeApi = acquireVsCodeApi();
    const canvas = document.getElementById('terrain');
    const ctx = canvas.getContext('2d');
    const logEl = document.getElementById('log');
    const statusEl = document.getElementById('status');
    const terminalForm = document.getElementById('terminal-input');
    const terminalPrompt = document.getElementById('terminal-prompt');
    const terminalValue = document.getElementById('terminal-value');
    const speedInput = document.getElementById('speed');
    const zoomOutButton = document.getElementById('btn-zoom-out');
    const zoomInButton = document.getElementById('btn-zoom-in');
    const zoomValue = document.getElementById('zoom-value');

    const initialDataEl = document.getElementById('initial-data');
    const assetsUri = initialDataEl ? initialDataEl.getAttribute('data-assets-uri') : '';
    const initialTerrain = initialDataEl ? initialDataEl.getAttribute('data-terrain') : null;
    const initialProgram = initialDataEl ? initialDataEl.getAttribute('data-program') : null;
    let initialClassSources = [];
    try {
        initialClassSources = JSON.parse(initialDataEl?.getAttribute('data-class-sources') || '[]');
    } catch {}

    let runnerState = null;
    let currentSource = '';
    let currentClassSources = Array.isArray(initialClassSources) ? initialClassSources : [];
    let resumeAfterInput = null;
    let runTimerId = null;

    function appendLog(text, isError) {
        const div = document.createElement('div');
        div.textContent = text;
        if (isError) div.className = 'log-error';
        logEl.appendChild(div);
        logEl.scrollTop = logEl.scrollHeight;
    }
    function clearLog() { logEl.innerHTML = ''; }

    const { engine, initEngine, getEngineState } = createSimulatorEngine(() => renderer.render());
    const renderer = createSimulatorRenderer({
        canvas, ctx, assetsUri, getEngineState,
        zoomValueEl: zoomValue, zoomOutButton, zoomInButton,
    });

    function readTerminalValue(kind, hamsterId, prompt) {
        const engineState = getEngineState();
        const value = kind === 'number'
            ? engine.readInt(hamsterId, prompt)
            : engine.readString(hamsterId, prompt);
        if (engineState.terminal.needsInput) {
            throw new window.RunnerPause(engineState.terminal.prompt);
        }
        return value;
    }

    const runtime = createHamsterRuntime({ engine, getEngineState, appendLog, readTerminalValue });

    function requestTerminalInput(prompt, resume) {
        resumeAfterInput = resume;
        terminalPrompt.textContent = String(prompt || 'Input:');
        terminalValue.value = '';
        terminalForm.classList.add('visible');
        statusEl.textContent = 'Waiting for input';
        terminalValue.focus();
    }

    function cancelTerminalInput() {
        resumeAfterInput = null;
        terminalForm.classList.remove('visible');
        const engineState = getEngineState();
        if (engineState) {
            engineState.terminal.needsInput = false;
            engineState.terminal.prompt = '';
        }
    }

    function stopRunLoop() {
        if (runTimerId !== null) { clearTimeout(runTimerId); runTimerId = null; }
    }

    function parseClassModules() {
        return currentClassSources.map(source => {
            const moduleAst = window.parseProgram(source, { requireMain: false, strict: true });
            if (!moduleAst.classes?.length) {
                throw new Error('A discovered class program did not declare a class.');
            }
            return moduleAst;
        });
    }

    function compileProgram() {
        if (!currentSource) {
            vscodeApi.postMessage({ type: 'error', message: 'No program loaded. Open a .ham file first.' });
            return false;
        }
        if (!window.parseProgram) {
            vscodeApi.postMessage({ type: 'error', message: 'Language tools not loaded yet.' });
            return false;
        }
        runnerState = null;
        clearLog();
        try {
            const ast = window.parseProgram(currentSource);
            if (ast.programType === 'class') {
                throw new Error('Class programs cannot be run directly.');
            }
            runnerState = window.createRunnerState(ast, runtime, parseClassModules());
            return true;
        } catch (e) {
            appendLog('Compile error: ' + (e.message || e), true);
            statusEl.textContent = 'Compile error';
            return false;
        }
    }

    const dbg = createDebuggerController({
        vscodeApi,
        engine,
        render: () => renderer.render(),
        getEngineState,
        getRunnerState: () => runnerState,
        setRunnerState: (state) => { runnerState = state; },
        compileProgram,
        appendLog,
        setStatus: (text) => { statusEl.textContent = text; },
        requestTerminalInput,
        cancelTerminalInput,
        stopRunLoop,
        clearLog,
        setCurrentSource: (source) => { currentSource = source; },
        getSpeedMs: () => parseInt(speedInput.value),
    });

    function doStepInternal(resumeOnInput) {
        if (!runnerState || runnerState.finished) return false;
        try {
            const progressed = window.executeRunnerStep(runnerState);
            renderer.render();
            const engineState = getEngineState();
            if (engineState.log.length > 0) {
                appendLog(engineState.log[engineState.log.length - 1]);
            }
            // Send current line to extension for editor highlighting
            const loc = runnerState.lastInstruction?.loc;
            if (loc && loc.line) {
                vscodeApi.postMessage({ type: 'highlightLine', line: loc.line });
            }
            if (!progressed) {
                runnerState.finished = true;
                vscodeApi.postMessage({ type: 'clearHighlight' });
                return false;
            }
            return !runnerState.finished;
        } catch (e) {
            if (window.RunnerPause && e instanceof window.RunnerPause) {
                renderer.render();
                requestTerminalInput(e.message, resumeOnInput);
                return true;
            }
            appendLog('Runtime error: ' + (e.message || e), true);
            runnerState.finished = true;
            vscodeApi.postMessage({ type: 'clearHighlight' });
            renderer.render();
            return false;
        }
    }

    function doCompile() {
        doStop();
        runnerState = null;
        if (!currentSource) {
            statusEl.textContent = 'No program loaded';
            vscodeApi.postMessage({ type: 'error', message: 'No program loaded. Open a .ham file first.' });
            return;
        }
        if (!window.parseProgram) {
            statusEl.textContent = 'Language tools not loaded';
            vscodeApi.postMessage({ type: 'error', message: 'Language tools not loaded yet.' });
            return;
        }
        clearLog();
        try {
            const ast = window.parseProgram(currentSource, { strict: true });
            window.createRunnerState(ast, runtime, parseClassModules());
            appendLog('Compilation successful \u2013 no errors found.');
            statusEl.textContent = 'Compiled successfully';
            vscodeApi.postMessage({ type: 'info', message: 'Compilation successful \u2013 no errors found.' });
        } catch (e) {
            const msg = e.message || String(e);
            appendLog('Compile error: ' + msg, true);
            statusEl.textContent = 'Compile error';
            if (e.token && e.token.line) {
                vscodeApi.postMessage({ type: 'highlightLine', line: e.token.line });
            }
            vscodeApi.postMessage({ type: 'error', message: 'Compile error: ' + msg });
        }
    }

    function doRun() {
        if (runTimerId !== null) return;
        if (!runnerState || runnerState.finished) {
            if (!compileProgram()) return;
        }
        engine.start();
        statusEl.textContent = 'Running...';
        function tick() {
            const hasMore = doStepInternal(() => {
                statusEl.textContent = 'Running...';
                runTimerId = setTimeout(tick, 0);
            });
            if (resumeAfterInput) {
                runTimerId = null;
                return;
            }
            if (hasMore) {
                runTimerId = setTimeout(tick, parseInt(speedInput.value));
            } else {
                runTimerId = null;
                statusEl.textContent = 'Finished';
            }
        }
        tick();
    }

    function doStep() {
        if (!runnerState || runnerState.finished) {
            if (!compileProgram()) return;
            engine.start();
        }
        const hasMore = doStepInternal(doStep);
        if (resumeAfterInput) return;
        statusEl.textContent = hasMore ? 'Stepped' : 'Finished';
    }

    function doStop() {
        stopRunLoop();
        cancelTerminalInput();
        vscodeApi.postMessage({ type: 'clearHighlight' });
        statusEl.textContent = 'Stopped';
    }

    function doReset() {
        doStop();
        runnerState = null;
        engine.reset();
        clearLog();
        vscodeApi.postMessage({ type: 'clearHighlight' });
        statusEl.textContent = 'Reset';
    }

    function handleCommand(cmd) {
        switch (cmd) {
            case 'compile': doCompile(); break;
            case 'run': doRun(); break;
            case 'step': doStep(); break;
            case 'stop': doStop(); break;
            case 'reset': doReset(); break;
        }
    }

    terminalForm.addEventListener('submit', event => {
        event.preventDefault();
        if (!resumeAfterInput) return;
        const resume = resumeAfterInput;
        engine.provideInput(terminalValue.value);
        resumeAfterInput = null;
        terminalForm.classList.remove('visible');
        resume();
    });

    document.getElementById('btn-compile').addEventListener('click', () =>
        vscodeApi.postMessage({ type: 'commandRequest', command: 'compile' })
    );
    document.getElementById('btn-run').addEventListener('click', () =>
        vscodeApi.postMessage({ type: 'commandRequest', command: 'run' })
    );
    document.getElementById('btn-step').addEventListener('click', () =>
        vscodeApi.postMessage({ type: 'commandRequest', command: 'step' })
    );
    document.getElementById('btn-stop').addEventListener('click', () => handleCommand('stop'));
    document.getElementById('btn-reset').addEventListener('click', () => handleCommand('reset'));
    zoomOutButton.addEventListener('click', () => renderer.setZoom(renderer.getCellSize() - ZOOM_STEP));
    zoomInButton.addEventListener('click', () => renderer.setZoom(renderer.getCellSize() + ZOOM_STEP));
    renderer.setZoom(DEFAULT_CELL_SIZE);

    // ── Terrain editor toolbar (shares the terrain with the simulator engine) ──
    let currentTool = 'wall';
    let isDragging = false;
    let lastPaintCell = null;
    const toolButtons = document.querySelectorAll('[data-tool]');
    const cornInput = document.getElementById('corn-amount');
    const hoverInfo = document.getElementById('hover-info');

    toolButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            currentTool = btn.dataset.tool;
            toolButtons.forEach(b => b.classList.toggle('active', b === btn));
        });
    });

    document.getElementById('btn-new-terrain').addEventListener('click', () => {
        const w = parseInt(document.getElementById('ter-w').value, 10);
        const h = parseInt(document.getElementById('ter-h').value, 10);
        if (isNaN(w) || isNaN(h) || w < 1 || h < 1) return;
        initEngine(w, h);
        clearLog();
        runnerState = null;
        statusEl.textContent = 'New terrain ' + w + '\u00d7' + h;
    });

    function applyTool(cell) {
        if (runTimerId !== null || !getEngineState()) return;
        let changed = null;
        try {
            switch (currentTool) {
                case 'wall':
                    if (!cell) return;
                    changed = engine.setWall(cell.x, cell.y, 1); break;
                case 'erase':
                    if (!cell) return;
                    engine.setWall(cell.x, cell.y, 0);
                    changed = engine.setCorn(cell.x, cell.y, 0); break;
                case 'corn':
                    if (!cell) return;
                    engine.setWall(cell.x, cell.y, 0);
                    changed = engine.setCorn(cell.x, cell.y, readCornAmount(cornInput)); break;
                case 'hamster':
                    if (!cell) return;
                    changed = engine.setDefaultHamster(cell.x, cell.y); break;
                case 'rotate':
                    changed = engine.rotateDefaultHamster(1); break;
            }
        } catch (err) {
            statusEl.textContent = err.message || 'Edit failed';
            return;
        }
        if (changed) { renderer.render(); lastPaintCell = cell || null; }
    }

    canvas.addEventListener('mousedown', evt => {
        const cell = eventToCell(evt, canvas, getEngineState()?.terrain);
        if (currentTool !== 'rotate' && !cell) return;
        isDragging = true; lastPaintCell = null;
        applyTool(cell);
    });
    canvas.addEventListener('mousemove', evt => {
        const cell = eventToCell(evt, canvas, getEngineState()?.terrain);
        updateHoverText(hoverInfo, getEngineState()?.terrain, cell);
        if (!isDragging) return;
        if (currentTool !== 'rotate' && cell && lastPaintCell && lastPaintCell.x === cell.x && lastPaintCell.y === cell.y) return;
        applyTool(cell);
    });
    canvas.addEventListener('mouseleave', () => { updateHoverText(hoverInfo, null, null); isDragging = false; lastPaintCell = null; });
    window.addEventListener('mouseup', () => { isDragging = false; lastPaintCell = null; });

    // ── Message handling from extension host ──
    window.addEventListener('message', event => {
        const msg = event.data;
        switch (msg.type) {
            case 'loadProgram':
                stopRunLoop();
                cancelTerminalInput();
                runnerState = null;
                currentSource = msg.source;
                currentClassSources = Array.isArray(msg.classSources) ? msg.classSources : [];
                statusEl.textContent = 'Program loaded';
                break;
            case 'loadTerrain':
                doStop();
                try {
                    engine.loadTerrain(msg.terrain);
                    statusEl.textContent = 'Terrain loaded';
                } catch (e) {
                    statusEl.textContent = 'Terrain error: ' + (e.message || e);
                    console.error('loadTerrain failed:', e, 'input:', JSON.stringify(msg.terrain).substring(0, 200));
                }
                break;
            case 'resetTerrain':
                doStop();
                initEngine(10, 8);
                statusEl.textContent = 'Terrain reset to default';
                break;
            case 'command':
                handleCommand(msg.command);
                break;
            case 'dbg:launch':
                currentClassSources = Array.isArray(msg.classSources) ? msg.classSources : [];
                dbg.launch(msg);
                break;
            case 'dbg:setBreakpoints': dbg.setBreakpoints(msg.lines || []); break;
            case 'dbg:continue': dbg.continueRun(); break;
            case 'dbg:next': dbg.next(); break;
            case 'dbg:stepIn': dbg.stepIn(); break;
            case 'dbg:stepOut': dbg.stepOut(); break;
            case 'dbg:pause': dbg.pause(); break;
            case 'dbg:stackTrace': dbg.sendStackTrace(msg.requestId); break;
            case 'dbg:scopes': dbg.sendScopes(msg.requestId, msg.frameId); break;
            case 'dbg:variables': dbg.sendVariables(msg.requestId, msg.variablesReference); break;
            case 'dbg:evaluate': dbg.evaluate(msg.requestId, msg.expression, msg.frameId); break;
            case 'dbg:disconnect': dbg.disconnect(); break;
        }
    });

    // Init terrain – use embedded data if provided, else default 10x8
    if (initialTerrain) {
        try { engine.loadTerrain(initialTerrain); }
        catch (e) { initEngine(10, 8); }
    } else {
        initEngine(10, 8);
    }
    if (initialProgram) {
        currentSource = initialProgram;
    }
}

bootstrap();
