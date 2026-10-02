/**
 * Canvas renderer for the terrain editor webview: terrain grid/corn (shared
 * with the simulator via `../shared/terrainCanvasRenderer.js`) plus hamster
 * sprites drawn as-is (no per-color tinting, unlike the simulator), with a
 * colored-circle fallback until the sprite image has loaded.
 */
import { drawTerrainBase, drawMouthBubble, drawHamsterFallback } from '../shared/terrainCanvasRenderer.js';
import { DIRECTION_ARROWS } from '../shared/terrainEngineState.js';

export const CELL = 48;

const HAMSTER_COLORS = [
    '#0000ff', '#ff0000', '#00ff00', '#ffff00', '#00ffff',
    '#ff00ff', '#ffc800', '#ffafaf', '#808080', '#ffffff',
];

/**
 * @param {object} deps
 * @param {HTMLCanvasElement} deps.canvas
 * @param {CanvasRenderingContext2D} deps.ctx
 * @param {string} deps.assetsUri
 * @param {() => object} deps.getEngineState
 * @param {HTMLInputElement} deps.mouthInput mirrors the default hamster's mouth content
 */
export function createTerrainEditorRenderer({ canvas, ctx, assetsUri, getEngineState, mouthInput }) {
    const spriteNames = ['hamsternorth.png', 'hamstereast.png', 'hamstersouth.png', 'hamsterwest.png'];
    const sprites = spriteNames.map(name => {
        const img = new Image();
        img.src = assetsUri + '/' + name;
        img.onload = () => render();
        return img;
    });

    function drawHamster(h) {
        const dir = ((h.dir % 4) + 4) % 4;
        const sprite = sprites[dir];
        if (sprite && sprite.complete && sprite.naturalWidth > 0) {
            const x = h.x * CELL, y = h.y * CELL, pad = Math.max(2, Math.floor(CELL * 0.08));
            ctx.drawImage(sprite, x + pad, y + pad, CELL - pad * 2, CELL - pad * 2);
            if (h.mouth > 0) {
                drawMouthBubble(ctx, x + CELL * 0.78, y + CELL * 0.22, CELL, h.mouth);
            }
            return;
        }
        const numericColor = Number(h.color);
        const colorIndex = Number.isFinite(numericColor) ? Math.trunc(numericColor) : 0;
        const normalizedColorIndex = ((colorIndex % HAMSTER_COLORS.length) + HAMSTER_COLORS.length) % HAMSTER_COLORS.length;
        drawHamsterFallback(ctx, h, CELL, HAMSTER_COLORS[normalizedColorIndex], DIRECTION_ARROWS[dir]);
    }

    function render() {
        const state = getEngineState();
        if (!state) return;
        const defaultHamster = state.terrain.hamsters.find(h => h.id === -1);
        if (mouthInput && defaultHamster) mouthInput.value = String(defaultHamster.mouth);
        drawTerrainBase(ctx, canvas, state.terrain, CELL);
        for (const h of state.terrain.hamsters) drawHamster(h);
    }

    return { render };
}
