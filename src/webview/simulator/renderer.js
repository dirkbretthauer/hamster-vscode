/**
 * Canvas renderer for the simulator webview: terrain grid/corn (shared with
 * the terrain editor via `../shared/terrainCanvasRenderer.js`) plus hamster
 * sprites tinted per hamster color, with a colored-circle fallback until the
 * sprite image has loaded. Also owns the zoom level.
 */
import { drawTerrainBase, drawMouthBubble, drawHamsterFallback } from '../shared/terrainCanvasRenderer.js';
import { DIRECTION_ARROWS } from '../shared/terrainEngineState.js';

export const DEFAULT_CELL_SIZE = 32;
const MIN_CELL_SIZE = 4;
const MAX_CELL_SIZE = 96;
export const ZOOM_STEP = 4;

const HAMSTER_COLORS = [
    { css: '#0000ff', rgb: [0, 0, 255] },
    { css: '#ff0000', rgb: [255, 0, 0] },
    { css: '#00ff00', rgb: [0, 255, 0] },
    { css: '#ffff00', rgb: [255, 255, 0] },
    { css: '#00ffff', rgb: [0, 255, 255] },
    { css: '#ff00ff', rgb: [255, 0, 255] },
    { css: '#ffc800', rgb: [255, 200, 0] },
    { css: '#ffafaf', rgb: [255, 175, 175] },
    { css: '#808080', rgb: [128, 128, 128] },
    { css: '#ffffff', rgb: [255, 255, 255] },
];

function getHamsterColorIndex(color) {
    const numericColor = Number(color);
    const index = Number.isFinite(numericColor) ? Math.trunc(numericColor) : 0;
    return ((index % HAMSTER_COLORS.length) + HAMSTER_COLORS.length) % HAMSTER_COLORS.length;
}

/**
 * @param {object} deps
 * @param {HTMLCanvasElement} deps.canvas
 * @param {CanvasRenderingContext2D} deps.ctx
 * @param {string} deps.assetsUri webview URI of the `assets/` folder, for sprite images
 * @param {() => object} deps.getEngineState
 * @param {HTMLElement} deps.zoomValueEl
 * @param {HTMLButtonElement} deps.zoomOutButton
 * @param {HTMLButtonElement} deps.zoomInButton
 */
export function createSimulatorRenderer({ canvas, ctx, assetsUri, getEngineState, getActiveHamsterId, zoomValueEl, zoomOutButton, zoomInButton }) {
    let cellSize = DEFAULT_CELL_SIZE;
    const tintedSprites = new Map();
    const spriteNames = ['hamsternorth.png', 'hamstereast.png', 'hamstersouth.png', 'hamsterwest.png'];
    const sprites = spriteNames.map(name => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = assetsUri + '/' + name;
        img.onload = () => {
            tintedSprites.clear();
            render();
        };
        return img;
    });

    function getTintedSprite(sprite, dir, colorIndex) {
        const cacheKey = dir + ':' + colorIndex;
        const cached = tintedSprites.get(cacheKey);
        if (cached) return cached;

        try {
            const color = HAMSTER_COLORS[colorIndex];
            const tinted = document.createElement('canvas');
            tinted.width = sprite.naturalWidth;
            tinted.height = sprite.naturalHeight;
            const tintedContext = tinted.getContext('2d');
            if (!tintedContext) throw new Error('Could not create a canvas context for sprite tinting.');
            tintedContext.drawImage(sprite, 0, 0);
            const imageData = tintedContext.getImageData(0, 0, tinted.width, tinted.height);
            const pixels = imageData.data;
            for (let i = 0; i < pixels.length; i += 4) {
                if (pixels[i + 2] > pixels[i] && pixels[i + 2] > pixels[i + 1]) {
                    pixels[i] = color.rgb[0];
                    pixels[i + 1] = color.rgb[1];
                    pixels[i + 2] = color.rgb[2];
                }
            }
            tintedContext.putImageData(imageData, 0, 0);
            tintedSprites.set(cacheKey, tinted);
            return tinted;
        } catch (error) {
            console.error('Failed to tint hamster sprite; using the original sprite.', error);
            tintedSprites.set(cacheKey, sprite);
            return sprite;
        }
    }

    /**
     * Ring around the hamster that performed the most recent action, so a
     * student watching several hamsters can tell which one just acted.
     */
    function drawActiveMarker(h) {
        const x = h.x * cellSize, y = h.y * cellSize;
        const inset = Math.max(1, Math.floor(cellSize * 0.04));
        ctx.save();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(2, Math.floor(cellSize * 0.06));
        ctx.setLineDash([Math.max(3, cellSize * 0.18), Math.max(2, cellSize * 0.1)]);
        ctx.strokeRect(x + inset, y + inset, cellSize - inset * 2, cellSize - inset * 2);
        ctx.restore();
    }

    function drawHamster(h) {
        const dir = ((h.dir % 4) + 4) % 4;
        const sprite = sprites[dir];
        const colorIndex = getHamsterColorIndex(h.color);
        const color = HAMSTER_COLORS[colorIndex];
        if (sprite && sprite.complete && sprite.naturalWidth > 0) {
            const x = h.x * cellSize, y = h.y * cellSize, pad = Math.max(1, Math.floor(cellSize * 0.08));
            ctx.drawImage(getTintedSprite(sprite, dir, colorIndex), x + pad, y + pad, cellSize - pad * 2, cellSize - pad * 2);
            if (h.mouth > 0) {
                drawMouthBubble(ctx, x + cellSize * 0.78, y + cellSize * 0.22, cellSize, h.mouth);
            }
            return;
        }
        drawHamsterFallback(ctx, h, cellSize, color.css, DIRECTION_ARROWS[dir]);
    }

    function render() {
        const state = getEngineState();
        if (!state) return;
        drawTerrainBase(ctx, canvas, state.terrain, cellSize);
        const activeId = typeof getActiveHamsterId === 'function' ? getActiveHamsterId() : null;
        for (const h of state.terrain.hamsters) {
            drawHamster(h);
            if (activeId != null && h.id === activeId) drawActiveMarker(h);
        }
    }

    function setZoom(nextCellSize) {
        cellSize = Math.min(MAX_CELL_SIZE, Math.max(MIN_CELL_SIZE, nextCellSize));
        zoomValueEl.textContent = cellSize + ' px';
        zoomOutButton.disabled = cellSize === MIN_CELL_SIZE;
        zoomInButton.disabled = cellSize === MAX_CELL_SIZE;
        render();
    }

    return {
        render,
        setZoom,
        getCellSize: () => cellSize,
    };
}
