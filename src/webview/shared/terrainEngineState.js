/**
 * Terrain/hamster state-machine pieces shared by the simulator webview
 * (`src/webview/simulator/`) and the terrain editor webview
 * (`src/webview/terrainEditor/`). Both webviews keep their own mutable
 * `engineState` (the simulator additionally tracks run/debug state and the
 * built-in Hamster API), but the plain terrain shape, cloning, and
 * bounds/wall checks are identical, so they live here once.
 */

/** Direction vectors/arrows indexed by the `dir` field on a hamster (0=N,1=E,2=S,3=W). */
export const DX = [0, 1, 0, -1];
export const DY = [-1, 0, 1, 0];
export const DIRECTION_ARROWS = ['\u2191', '\u2192', '\u2193', '\u2190'];

/** Creates an empty terrain of the given size with a single default hamster at (0,0) facing east. */
export function makeTerrain(width, height) {
    return {
        width,
        height,
        walls: Array.from({ length: height }, () => Array(width).fill(0)),
        corn: Array.from({ length: height }, () => Array(width).fill(0)),
        hamsters: [{ id: -1, x: 0, y: 0, dir: 1, mouth: 0, color: 0 }],
    };
}

/** Deep-clones engine state so callers can't mutate the live simulator/editor state by accident. */
export function cloneState(state) {
    return JSON.parse(JSON.stringify(state));
}

export function insideTerrain(terrain, x, y) {
    return x >= 0 && y >= 0 && y < terrain.height && x < terrain.width;
}

export function isWallAt(terrain, x, y) {
    return !insideTerrain(terrain, x, y) || terrain.walls[y][x] === 1;
}

/** Looks up a hamster by id, returning `undefined` instead of throwing so callers can pick their own error. */
export function findHamster(terrain, id) {
    return terrain.hamsters.find(h => h.id === id);
}
