/**
 * UI bootstrap and event wiring for the terrain editor webview: paint/drag
 * tool handlers, undo-friendly stroke coalescing, and `.ter` serialization,
 * moved out of `terrainEditor.ts`'s inline script. Delegates terrain state
 * and rendering to `./engine.js` / `./renderer.js`.
 */
import { createTerrainEditorEngine } from './engine.js';
import { createTerrainEditorRenderer } from './renderer.js';
import { eventToCell, updateHoverText, readCornAmount } from '../shared/terrainHitTest.js';

export function bootstrap() {
    const vscodeApi = acquireVsCodeApi();
    const canvas = document.getElementById('terrain');
    const ctx = canvas.getContext('2d');
    const mouthInput = document.getElementById('hamster-mouth');

    const initialDataEl = document.getElementById('initial-data');
    const assetsUri = initialDataEl ? initialDataEl.getAttribute('data-assets-uri') : '';
    const initialTerrain = initialDataEl ? initialDataEl.getAttribute('data-terrain') : null;

    const { engine, initEngine, getEngineState, terrainToTer } = createTerrainEditorEngine(() => renderer.render());
    const renderer = createTerrainEditorRenderer({ canvas, ctx, assetsUri, getEngineState, mouthInput });

    function notifyChanged() {
        vscodeApi.postMessage({ type: 'terrainChanged', content: terrainToTer() });
    }

    // ── Init from embedded data ──
    if (initialTerrain) {
        try { engine.loadTerrain(initialTerrain); } catch (e) { initEngine(10, 8); }
    } else {
        initEngine(10, 8);
    }

    // ── External document changes ──
    window.addEventListener('message', event => {
        if (event.data.type === 'loadTerrain') {
            engine.loadTerrain(event.data.terrain);
        }
    });

    // ── Terrain editing ──
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
        notifyChanged();
    });

    mouthInput?.addEventListener('change', () => {
        engine.setDefaultHamsterMouth(mouthInput.value);
        renderer.render();
        notifyChanged();
    });

    // Coalesce every cell painted during a single pointer-down drag into one
    // persisted change, sent when the stroke ends (pointer up/leave).
    let strokeDirty = false;
    function endStroke() {
        isDragging = false; lastPaintCell = null;
        if (strokeDirty) { strokeDirty = false; notifyChanged(); }
    }

    function applyTool(cell) {
        let changed = false;
        try {
            switch (currentTool) {
                case 'wall':
                    if (!cell) return;
                    engine.setWall(cell.x, cell.y, 1); changed = true; break;
                case 'erase':
                    if (!cell) return;
                    engine.setWall(cell.x, cell.y, 0);
                    engine.setCorn(cell.x, cell.y, 0);
                    engine.removeAdditionalHamster(cell.x, cell.y);
                    changed = true; break;
                case 'corn':
                    if (!cell) return;
                    engine.setWall(cell.x, cell.y, 0);
                    engine.setCorn(cell.x, cell.y, readCornAmount(cornInput));
                    changed = true; break;
                case 'hamster':
                    if (!cell) return;
                    engine.setDefaultHamster(cell.x, cell.y); changed = true; break;
                case 'rotate':
                    engine.rotateDefaultHamster(1); changed = true; break;
            }
        } catch (err) { return; }
        if (changed) { renderer.render(); lastPaintCell = cell || null; strokeDirty = true; }
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
    canvas.addEventListener('mouseleave', () => { updateHoverText(hoverInfo, null, null); if (isDragging) endStroke(); });
    window.addEventListener('mouseup', () => { if (isDragging) endStroke(); });
}

bootstrap();
