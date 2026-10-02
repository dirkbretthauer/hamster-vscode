/**
 * Simulator terrain + hamster state machine and built-in Hamster API
 * (`vor`, `nimm`, ...), moved out of `hamsterPanel.ts`'s inline script.
 * Mirrors the terrain editor's engine (`../terrainEditor/engine.js`) but
 * additionally tracks run/debug `state`, the instruction log, and terminal
 * input needed to actually execute `.ham` programs.
 */
import {
    DX, DY, makeTerrain, cloneState, insideTerrain, isWallAt, findHamster,
} from '../shared/terrainEngineState.js';

/** Tags an `Error` with the Hamster exception type name the runner/debugger expect. */
export function hamsterError(type, message) {
    const error = new Error(message);
    error.hamsterExceptionType = type;
    return error;
}

/**
 * @param {() => void} renderCallback invoked after terrain init/load/reset,
 *   mirroring the inline render() calls the original webview script made at
 *   those same three points (gameplay/editing ops render via the caller
 *   instead, exactly as before).
 */
export function createSimulatorEngine(renderCallback) {
    const render = renderCallback || (() => {});
    let engineState = null;
    let snapshot = null;
    let nextId = 0;
    let pendingInput = null;

    function inside(x, y) {
        return insideTerrain(engineState.terrain, x, y);
    }
    function isWall(x, y) {
        return isWallAt(engineState.terrain, x, y);
    }
    function getHamster(id) {
        const h = findHamster(engineState.terrain, id);
        if (!h) throw hamsterError('HamsterNotInitializedException', 'Hamster not initialised');
        return h;
    }
    function engineLog(msg) {
        engineState.log.push(msg);
        if (engineState.log.length > 200) engineState.log = engineState.log.slice(-200);
    }

    function initEngine(w, h) {
        engineState = {
            state: 0,
            terrain: makeTerrain(Math.max(1, w | 0), Math.max(1, h | 0)),
            log: [],
            terminal: { needsInput: false, prompt: '', output: [] },
        };
        snapshot = null;
        nextId = 0;
        render();
        return engineState;
    }

    const engine = {
        init: (w, h) => initEngine(w, h),
        loadTerrain(terString) {
            const parsed = parseTerrainFile(terString);
            if (!parsed) { initEngine(1, 1); return cloneState(engineState); }
            initEngine(parsed.width, parsed.height);
            for (let row = 0; row < parsed.height; row++) {
                for (let col = 0; col < parsed.width; col++) {
                    engineState.terrain.walls[row][col] = parsed.walls[row][col];
                    engineState.terrain.corn[row][col] = parsed.corn[row][col];
                }
            }
            const def = getHamster(-1);
            def.x = parsed.defaultHamster.x;
            def.y = parsed.defaultHamster.y;
            def.dir = parsed.defaultHamster.dir;
            def.mouth = parsed.defaultHamster.mouth;
            for (const hamster of parsed.additionalHamsters) {
                const id = nextId++;
                engineState.terrain.hamsters.push({
                    id, x: hamster.x, y: hamster.y, dir: hamster.dir, mouth: hamster.mouth, color: hamster.color,
                });
            }
            render();
            return cloneState(engineState);
        },
        start() { snapshot = cloneState(engineState); engineState.state = 1; return cloneState(engineState); },
        reset() { if (snapshot) engineState = cloneState(snapshot); engineState.state = 0; render(); return cloneState(engineState); },
        vor(id = -1) {
            const h = getHamster(id);
            const nx = h.x + DX[h.dir];
            const ny = h.y + DY[h.dir];
            if (isWall(nx, ny)) throw hamsterError('WallInFrontException', 'Wall at row=' + ny + ', col=' + nx);
            h.x = nx; h.y = ny; engineLog('[H' + id + '] vor()'); return cloneState(engineState);
        },
        linksUm(id = -1) { const h = getHamster(id); h.dir = (h.dir + 3) % 4; engineLog('[H' + id + '] linksUm()'); return cloneState(engineState); },
        nimm(id = -1) {
            const h = getHamster(id);
            const c = engineState.terrain.corn[h.y][h.x];
            if (c <= 0) throw hamsterError('TileEmptyException', 'No grain at row=' + h.y + ', col=' + h.x);
            engineState.terrain.corn[h.y][h.x] = c - 1; h.mouth += 1; engineLog('[H' + id + '] nimm()'); return cloneState(engineState);
        },
        gib(id = -1) {
            const h = getHamster(id);
            if (h.mouth <= 0) throw hamsterError('MouthEmptyException', 'Hamster mouth is empty');
            engineState.terrain.corn[h.y][h.x] += 1; h.mouth -= 1; engineLog('[H' + id + '] gib()'); return cloneState(engineState);
        },
        vornFrei(id = -1) { const h = getHamster(id); return !isWall(h.x + DX[h.dir], h.y + DY[h.dir]); },
        kornDa(id = -1) { return engineState.terrain.corn[getHamster(id).y][getHamster(id).x] > 0; },
        maulLeer(id = -1) { return getHamster(id).mouth === 0; },
        getReihe(id = -1) { return getHamster(id).y; },
        getSpalte(id = -1) { return getHamster(id).x; },
        getBlickrichtung(id = -1) { return getHamster(id).dir; },
        getAnzahlKoerner(id = -1) { return getHamster(id).mouth; },
        createHamster(row, col, dir, mouth, color = 1) {
            if (isWall(col, row)) throw new Error('Wall at spawn position');
            const id = nextId++;
            engineState.terrain.hamsters.push({ id, x: col, y: row, dir, mouth, color });
            return id;
        },
        getState() { return cloneState(engineState); },
        provideInput(val) {
            pendingInput = String(val);
            engineState.terminal.needsInput = false;
            engineState.terminal.prompt = '';
            engineState.terminal.output.push(String(val));
        },
        readInt(_hid = -1, prompt = '') {
            if (pendingInput != null) {
                const v = pendingInput;
                pendingInput = null;
                const n = parseInt(v, 10);
                return Number.isNaN(n) ? 0 : n;
            }
            engineState.terminal.needsInput = true;
            engineState.terminal.prompt = String(prompt || 'Enter number:');
            return 0;
        },
        readString(_hid = -1, prompt = '') {
            if (pendingInput != null) {
                const v = pendingInput;
                pendingInput = null;
                return v;
            }
            engineState.terminal.needsInput = true;
            engineState.terminal.prompt = String(prompt || 'Enter text:');
            return '';
        },
        setWall(col, row, value) {
            if (!inside(col, row)) return cloneState(engineState);
            if (value && engineState.terrain.hamsters.some(h => h.x === col && h.y === row)) return cloneState(engineState);
            engineState.terrain.walls[row][col] = value ? 1 : 0;
            if (value) engineState.terrain.corn[row][col] = 0;
            return cloneState(engineState);
        },
        setCorn(col, row, count) {
            if (inside(col, row)) engineState.terrain.corn[row][col] = Math.max(0, count | 0);
            return cloneState(engineState);
        },
        setDefaultHamster(col, row, dir) {
            if (!inside(col, row)) throw new Error('Position outside terrain');
            if (engineState.terrain.walls[row][col]) throw new Error('Cannot place hamster on a wall');
            const h = getHamster(-1);
            h.x = col; h.y = row;
            if (dir != null && !Number.isNaN(dir)) h.dir = ((dir % 4) + 4) % 4;
            return cloneState(engineState);
        },
        rotateDefaultHamster(turns) {
            const h = getHamster(-1);
            const d = (turns | 0);
            h.dir = ((h.dir + d) % 4 + 4) % 4;
            return cloneState(engineState);
        },
    };

    return {
        engine,
        initEngine,
        engineLog,
        inside,
        isWall,
        getHamster,
        /** Live (non-cloned) state reference, read directly by the renderer/runtime/debugger. */
        getEngineState: () => engineState,
    };
}
