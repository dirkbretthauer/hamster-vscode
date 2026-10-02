/**
 * Canvas drawing pieces shared by the simulator and terrain editor webviews:
 * the terrain grid/walls/corn background, and the plain circle-with-arrow
 * fallback used to draw a hamster when its sprite image isn't available yet.
 * Sprite loading/tinting differs between the two webviews (the simulator
 * tints sprites per hamster color, the terrain editor draws them as-is), so
 * that part stays in each webview's own renderer module.
 */

/** Draws the grid background, wall tiles, and corn piles for a terrain at the given cell size. */
export function drawTerrainBase(ctx, canvas, terrain, cell) {
    const { width, height, walls, corn } = terrain;
    canvas.width = width * cell;
    canvas.height = height * cell;

    ctx.fillStyle = '#f9f5e7';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 1;
    for (let x = 0; x <= width; x++) {
        ctx.beginPath();
        ctx.moveTo(x * cell, 0);
        ctx.lineTo(x * cell, height * cell);
        ctx.stroke();
    }
    for (let y = 0; y <= height; y++) {
        ctx.beginPath();
        ctx.moveTo(0, y * cell);
        ctx.lineTo(width * cell, y * cell);
        ctx.stroke();
    }

    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const px = col * cell;
            const py = row * cell;
            if (walls[row][col]) {
                ctx.fillStyle = '#555';
                ctx.fillRect(px + 1, py + 1, cell - 2, cell - 2);
                continue;
            }
            const cornCount = corn[row][col];
            if (cornCount > 0) {
                ctx.fillStyle = '#27ae60';
                ctx.beginPath();
                ctx.arc(px + cell / 2, py + cell / 2, cell * 0.22, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#fff';
                ctx.font = 'bold ' + (cell * 0.28) + 'px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(cornCount, px + cell / 2, py + cell / 2);
            }
        }
    }
}

/** Draws the mouth-content bubble shown over a hamster when its mouth isn't empty. */
export function drawMouthBubble(ctx, x, y, cell, mouth) {
    ctx.fillStyle = '#e74c3c';
    ctx.beginPath();
    ctx.arc(x, y, cell * 0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold ' + (cell * 0.22) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(mouth, x, y);
}

/** Fallback hamster drawing (colored circle + direction arrow) used until/unless the sprite image is ready. */
export function drawHamsterFallback(ctx, h, cell, cssColor, dirArrow) {
    const px = h.x * cell + cell / 2;
    const py = h.y * cell + cell / 2;
    const r = cell * 0.36;
    ctx.fillStyle = cssColor;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.font = 'bold ' + (cell * 0.4) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(dirArrow, px, py);
    if (h.mouth > 0) {
        drawMouthBubble(ctx, px + r * 0.7, py - r * 0.7, cell, h.mouth);
    }
}
