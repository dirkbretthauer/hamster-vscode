/**
 * Headless end-to-end harness for the Hamster simulator.
 *
 * Runs a real `.ham` program on a real `.ter` terrain through the real parser,
 * runner, scheduler, simulator engine and runtime adapter, then reports what
 * happened in the terrain. Everything below `src/webview/simulator/` is
 * DOM-free, so the whole stack runs under plain Node.
 *
 * Used by `test/simulationIntegration.test.mjs`; also importable from a script
 * to sweep a folder of programs (e.g. the reference corpus).
 *
 * Not covered here: canvas rendering, the DAP wire protocol, and anything
 * needing the `vscode` API — those still require the Extension Development Host.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Direction constants, matching `lang/hamster-terrain.js`. */
export const DIR_NORTH = 0, DIR_EAST = 1, DIR_SOUTH = 2, DIR_WEST = 3;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function moduleUrl(source) {
    return 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
}

function readModule(relativePath, replacements = {}) {
    let source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    for (const [specifier, url] of Object.entries(replacements)) {
        source = source.replaceAll(`'${specifier}'`, JSON.stringify(url));
    }
    return moduleUrl(source);
}

let stackPromise = null;

/** Load the whole simulator stack once: language modules plus webview runtime. */
function loadSimulatorStack() {
    if (stackPromise) return stackPromise;
    stackPromise = (async () => {
        const lexerUrl = readModule('lang/hamster-lexer.js');
        const parserUrl = readModule('lang/hamster-parser.js', { './hamster-lexer.js': lexerUrl });
        const terrainUrl = readModule('lang/hamster-terrain.js');
        const runnerUrl = readModule('lang/hamster-runner.js', { './hamster-parser.js': parserUrl });
        const schedulerUrl = readModule('lang/hamster-scheduler.js', { './hamster-runner.js': runnerUrl });
        const sharedStateUrl = readModule('src/webview/shared/terrainEngineState.js');

        // `engine.js` reaches `parseTerrainFile` as a webview global, published by
        // `src/webview/langBundleEntry.js` (`Object.assign(window, …)`). Headlessly
        // there is no bundle, so the same globals are installed by hand.
        const terrainModule = await import(terrainUrl);
        globalThis.parseTerrainFile = terrainModule.parseTerrainFile;
        globalThis.serializeTerrainFile = terrainModule.serializeTerrainFile;

        const engineUrl = readModule('src/webview/simulator/engine.js', {
            '../shared/terrainEngineState.js': sharedStateUrl,
        });
        const runtimeUrl = readModule('src/webview/simulator/runtime.js', {
            '../shared/terrainEngineState.js': sharedStateUrl,
            './engine.js': engineUrl,
        });
        return {
            parser: await import(parserUrl),
            runner: await import(runnerUrl),
            scheduler: await import(schedulerUrl),
            terrain: terrainModule,
            engine: await import(engineUrl),
            runtime: await import(runtimeUrl),
        };
    })();
    return stackPromise;
}

/** mulberry32 — deterministic selection so the suite is reliable under FR-010's varied scheduling. */
function seededRandom(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Build a `.ter` file. `rows` are the terrain lines (`#` wall, `*` corn,
 * `^>v<` hamster), `corn` lists the pile sizes in row-major order of the
 * `*`/hamster cells, and `mouth` is the default hamster's starting grain.
 */
export function terrainFile(rows, corn = [], mouth = 0, defaultAt = null) {
    const width = Math.max(...rows.map(row => row.length));
    const padded = rows.map(row => row.padEnd(width, ' '));
    const lines = [String(width), String(rows.length), ...padded, ...corn.map(String), String(mouth)];
    if (defaultAt) lines.push(`@default ${defaultAt[0]} ${defaultAt[1]}`);
    return lines.join('\n') + '\n';
}

/**
 * Find the `.ter` that belongs to a `.ham`, using the same policy as the
 * extension's own `src/terrainResolver.ts`: prefer the file with the matching
 * basename, otherwise the folder's single `.ter`, otherwise none.
 */
function resolveTerrainFor(programPath, encoding) {
    const dir = path.dirname(programPath);
    const exact = path.join(dir, path.basename(programPath, '.ham') + '.ter');
    if (fs.existsSync(exact)) return fs.readFileSync(exact, encoding);
    const candidates = fs.readdirSync(dir).filter(name => name.endsWith('.ter'));
    if (candidates.length === 1) return fs.readFileSync(path.join(dir, candidates[0]), encoding);
    return undefined;
}

/**
 * Collect the `/*class*\/` programs below the entry file's folder, matching
 * `src/hamsterClassResolver.ts`. Sorted by path so the result is deterministic.
 */
function discoverClassModules(programPath, encoding, detectProgramType, ProgramType) {
    const root = path.dirname(programPath);
    const found = [];
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.toLowerCase().endsWith('.ham')) continue;
            if (path.resolve(full) === path.resolve(programPath)) continue;
            const source = fs.readFileSync(full, encoding);
            if (detectProgramType(source) === ProgramType.Class) found.push({ full, source });
        }
    };
    walk(root);
    return found.sort((a, b) => a.full.localeCompare(b.full)).map(entry => entry.source);
}

/**
 * Run a program to completion against a real engine and report what happened.
 *
 * Source can come from disk or from inline strings:
 *
 *   runSimulation({ programPath: 'test/fixtures/simulation/collectRow.ham' })
 *   runSimulation({ program: 'void main() { vor(); }', terrain: terrainFile([...]) })
 *
 * With `programPath` and nothing else, the `.ter` is paired by basename and any
 * `/*class*\/` programs in the folder are loaded as class modules — exactly what
 * the extension does when you press Run on a `.ham` file.
 *
 * @param {object} options
 * @param {string} [options.programPath] a `.ham` file to load
 * @param {string} [options.program] inline `.ham` source (wins over `programPath`)
 * @param {string} [options.terrainPath] a `.ter` file to load
 * @param {string} [options.terrain] inline `.ter` text (wins over `terrainPath`)
 * @param {string[]} [options.classModules] inline class sources; suppresses auto-discovery
 * @param {Array<string|number>} [options.inputs] answers fed to `liesZahl`/`liesZeichenkette`
 * @param {number} [options.seed] scheduling seed
 * @param {BufferEncoding} [options.encoding] `latin1` for the reference corpus
 */
export async function runSimulation({
    programPath, program, terrainPath, terrain, classModules, inputs = [],
    seed = 1, maxSteps = 100000, encoding = 'utf8',
}) {
    const stack = await loadSimulatorStack();

    if (program === undefined) {
        if (!programPath) throw new Error('runSimulation needs either `program` or `programPath`');
        program = fs.readFileSync(path.resolve(root, programPath), encoding);
    }
    const resolvedProgramPath = programPath ? path.resolve(root, programPath) : null;

    if (terrain === undefined) {
        if (terrainPath) terrain = fs.readFileSync(path.resolve(root, terrainPath), encoding);
        else if (resolvedProgramPath) terrain = resolveTerrainFor(resolvedProgramPath, encoding);
    }

    if (classModules === undefined) {
        classModules = resolvedProgramPath
            ? discoverClassModules(
                resolvedProgramPath, encoding,
                stack.parser.detectProgramType, stack.parser.ProgramType)
            : [];
    }
    const { createSimulatorEngine } = stack.engine;
    const { createHamsterRuntime } = stack.runtime;

    const { engine, initEngine, getEngineState } = createSimulatorEngine();
    if (terrain) engine.loadTerrain(terrain); else initEngine(5, 5);

    const output = [];
    const pending = [...inputs];

    // Mirrors the webview's own readTerminalValue (src/webview/simulator/index.js),
    // including the RunnerPause it raises when no value is available yet.
    function readTerminalValue(kind, hamsterId, prompt) {
        const engineState = getEngineState();
        const value = kind === 'number'
            ? engine.readInt(hamsterId, prompt)
            : engine.readString(hamsterId, prompt);
        if (engineState.terminal.needsInput) {
            throw new stack.runner.RunnerPause(engineState.terminal.prompt);
        }
        return value;
    }

    const hamsterRuntime = createHamsterRuntime({
        engine,
        getEngineState,
        appendLog: text => output.push(String(text)),
        readTerminalValue,
    });

    const ast = stack.parser.parseProgram(program);
    const moduleAsts = classModules.map(source =>
        stack.parser.parseProgram(source, { requireMain: false, strict: true }));
    const state = stack.runner.createRunnerState(ast, hamsterRuntime, moduleAsts, {
        createScheduler: programState =>
            stack.scheduler.createScheduler(programState, { random: seededRandom(seed) }),
    });
    const scheduler = state.programState.scheduler;

    engine.start();

    const errors = [];
    let steps = 0;
    let result;
    let unansweredPrompt = null;
    while (true) {
        result = scheduler.step();
        for (const event of result.events) {
            if (event.kind === 'error') errors.push(event.error.message);
        }
        if (result.status === 'needsInput') {
            if (pending.length === 0) { unansweredPrompt = result.message; break; }
            engine.provideInput(pending.shift());
            scheduler.provideInput(result.thread);
        }
        if (result.status === 'finished' || result.status === 'deadlocked') break;
        if (++steps >= maxSteps) {
            throw new Error(
                `simulation did not terminate within ${maxSteps} steps (status ${result.status})`);
        }
    }

    const engineState = getEngineState();
    return {
        status: result.status,
        report: result.report,
        errors,
        output,
        unansweredPrompt,
        scheduler,
        engine,
        terrainState: engineState.terrain,
        /** The default hamster, or one by id. */
        hamster: (id = -1) => engineState.terrain.hamsters.find(h => h.id === id),
        hamsters: () => engineState.terrain.hamsters,
        cornAt: (row, col) => engineState.terrain.corn[row][col],
        totalCorn: () => engineState.terrain.corn
            .reduce((sum, row) => sum + row.reduce((a, b) => a + b, 0), 0),
        serialize: () => stack.terrain.serializeTerrainFile({
            width: engineState.terrain.width,
            height: engineState.terrain.height,
            walls: engineState.terrain.walls,
            corn: engineState.terrain.corn,
            hamsters: engineState.terrain.hamsters,
        }),
    };
}
