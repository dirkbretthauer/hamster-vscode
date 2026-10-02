/**
 * Canvas pointer hit-testing and hover-text formatting shared by the
 * simulator's terrain-edit toolbar and the terrain editor webview — both
 * paint onto a terrain canvas with the same cell math and hover label.
 */

/** Converts a mouse event over `canvas` into a terrain cell, or `null` if outside the terrain. */
export function eventToCell(evt, canvas, terrain) {
    if (!terrain) return null;
    const rect = canvas.getBoundingClientRect();
    const px = (evt.clientX - rect.left) * (canvas.width / rect.width);
    const py = (evt.clientY - rect.top) * (canvas.height / rect.height);
    const cellWidth = terrain.width ? canvas.width / terrain.width : 1;
    const cellHeight = terrain.height ? canvas.height / terrain.height : 1;
    const x = Math.floor(px / cellWidth);
    const y = Math.floor(py / cellHeight);
    if (x < 0 || y < 0 || x >= terrain.width || y >= terrain.height) return null;
    return { x, y };
}

/** Updates the hover-info label with the wall/corn/hamster contents of `cell`. */
export function updateHoverText(hoverInfoEl, terrain, cell) {
    if (!hoverInfoEl) return;
    if (!cell || !terrain) {
        hoverInfoEl.textContent = 'Row -, Col -';
        return;
    }
    const isWall = terrain.walls[cell.y][cell.x] === 1;
    const cornCount = terrain.corn[cell.y][cell.x];
    const hamster = terrain.hamsters.find(h => h.x === cell.x && h.y === cell.y);
    const parts = ['Row ' + cell.y, 'Col ' + cell.x];
    parts.push(isWall ? 'Wall' : 'Free');
    if (cornCount > 0) parts.push(cornCount + ' corn');
    if (hamster) parts.push('Hamster');
    hoverInfoEl.textContent = parts.join(' \u00b7 ');
}

/** Reads the non-negative corn amount configured in the edit toolbar's number input. */
export function readCornAmount(cornInputEl) {
    const value = parseInt(cornInputEl?.value ?? '0', 10);
    return Number.isNaN(value) ? 0 : Math.max(0, value);
}
