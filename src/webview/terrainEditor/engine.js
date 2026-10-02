/**
 * Terrain + hamster state machine for the terrain editor webview. Mirrors
 * the simulator's engine (`../simulator/engine.js`) but only exposes the
 * editing operations the `.ter` editor needs (no run/debug state, no
 * built-in Hamster API for program execution).
 */
import { makeTerrain, insideTerrain } from '../shared/terrainEngineState.js';

export function createTerrainEditorEngine(renderCallback) {
    const render = renderCallback || (() => {});
    let engineState = null;
    let nextId = 0;

    function inside(x, y) {
        return insideTerrain(engineState.terrain, x, y);
    }
    function getHamster(id) {
        const h = engineState.terrain.hamsters.find(x => x.id === id);
        if (!h) throw new Error('Hamster not initialised');
        return h;
    }

    function initEngine(w, h) {
        engineState = {
            state: 0,
            terrain: makeTerrain(Math.max(1, w | 0), Math.max(1, h | 0)),
            log: [],
            terminal: { needsInput: false, prompt: '', output: [] },
        };
        nextId = 0;
        render();
    }

    const engine = {
        loadTerrain(terString) {
            const parsed = parseTerrainFile(terString);
            if (!parsed) { initEngine(10, 8); return; }
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
        },
        setWall(col, row, value) {
            if (!inside(col, row)) return;
            if (value && engineState.terrain.hamsters.some(h => h.x === col && h.y === row)) return;
            engineState.terrain.walls[row][col] = value ? 1 : 0;
            if (value) engineState.terrain.corn[row][col] = 0;
        },
        setCorn(col, row, count) {
            if (inside(col, row)) engineState.terrain.corn[row][col] = Math.max(0, count | 0);
        },
        setDefaultHamster(col, row) {
            if (!inside(col, row)) throw new Error('Outside terrain');
            if (engineState.terrain.walls[row][col]) throw new Error('Cannot place on wall');
            if (engineState.terrain.hamsters.some(h => h.id !== -1 && h.x === col && h.y === row)) {
                throw new Error('Cannot place on another hamster');
            }
            const h = getHamster(-1);
            h.x = col; h.y = row;
        },
        rotateDefaultHamster(turns) {
            const h = getHamster(-1);
            h.dir = ((h.dir + (turns | 0)) % 4 + 4) % 4;
        },
        setDefaultHamsterMouth(count) {
            const numericCount = Number(count);
            getHamster(-1).mouth = Number.isFinite(numericCount) ? Math.max(0, Math.trunc(numericCount)) : 0;
        },
        removeAdditionalHamster(col, row) {
            engineState.terrain.hamsters = engineState.terrain.hamsters.filter(
                h => h.id === -1 || h.x !== col || h.y !== row
            );
        },
    };

    return {
        engine,
        initEngine,
        getEngineState: () => engineState,
        terrainToTer: () => (engineState ? serializeTerrainFile(engineState.terrain) : ''),
    };
}
