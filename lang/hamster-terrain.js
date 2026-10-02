/**
 * Parsing and serialization for the Hamster `.ter` terrain file format.
 *
 * Shared between the simulator webview (hamsterPanel.ts) and the terrain
 * editor webview (terrainEditor.ts) so both read/write terrain data the
 * same way. Pure, DOM-free logic so it can also be unit tested directly.
 *
 * File layout:
 *   line 0:        width
 *   line 1:        height
 *   lines 2..h+1:  one row per terrain line (`#`=wall, `*`=corn pile,
 *                  `^>v<`=hamster facing north/east/south/west on a corn pile)
 *   next N lines:  corn amount for each `*`/hamster cell, in row-major order
 *   next line:     the default hamster's mouth (corn) count
 *   optional line: `@default <x> <y>` selecting which hamster cell is the
 *                  default hamster when more than one hamster is present
 */

const DIR_NORTH = 0;
const DIR_EAST = 1;
const DIR_SOUTH = 2;
const DIR_WEST = 3;

const DIR_CHARS = ['^', '>', 'v', '<'];
const CHAR_TO_DIR = { '^': DIR_NORTH, '>': DIR_EAST, 'v': DIR_SOUTH, '<': DIR_WEST };

function normalizeDir(dir) {
    return ((dir % 4) + 4) % 4;
}

/**
 * Parses `.ter` source text.
 *
 * Returns `null` when the declared width/height is missing or invalid.
 * Otherwise returns `{ width, height, walls, corn, defaultHamster, additionalHamsters }`
 * where `walls`/`corn` are `height x width` arrays, `defaultHamster` is
 * `{x, y, dir, mouth}`, and `additionalHamsters` is an array of
 * `{x, y, dir, mouth, color}` for any extra hamster cells found.
 */
export function parseTerrainFile(text) {
    const lines = String(text).split(/\r?\n/);
    const width = parseInt(lines[0], 10);
    const height = parseInt(lines[1], 10);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
        return null;
    }

    const walls = Array.from({ length: height }, () => new Array(width).fill(0));
    const corn = Array.from({ length: height }, () => new Array(width).fill(0));
    const cornCells = [];
    const hamsterCells = [];

    for (let row = 0; row < height; row++) {
        const line = lines[row + 2] || '';
        for (let col = 0; col < width; col++) {
            const c = line[col] || ' ';
            if (c === '#') walls[row][col] = 1;
            if (c === '*' || c in CHAR_TO_DIR) cornCells.push([row, col]);
            if (c in CHAR_TO_DIR) hamsterCells.push({ x: col, y: row, dir: CHAR_TO_DIR[c] });
        }
    }

    const base = 2 + height;
    for (let i = 0; i < cornCells.length; i++) {
        const [row, col] = cornCells[i];
        const val = parseInt(lines[base + i] || '0', 10);
        corn[row][col] = Number.isNaN(val) ? 0 : val;
    }

    const mouthLine = base + cornCells.length;
    const mouth = parseInt(lines[mouthLine] || '0', 10);
    const defaultMetadata = /^@default\s+(\d+)\s+(\d+)\s*$/.exec(lines[mouthLine + 1] || '');
    const metadataX = defaultMetadata ? parseInt(defaultMetadata[1], 10) : -1;
    const metadataY = defaultMetadata ? parseInt(defaultMetadata[2], 10) : -1;

    let defaultIndex = hamsterCells.findIndex(h => h.x === metadataX && h.y === metadataY);
    if (defaultIndex < 0) defaultIndex = hamsterCells.length - 1;

    const normalizedMouth = Number.isNaN(mouth) ? 0 : mouth;
    let defaultHamster = { x: 0, y: 0, dir: DIR_EAST, mouth: normalizedMouth };
    const additionalHamsters = [];
    if (defaultIndex >= 0) {
        const def = hamsterCells[defaultIndex];
        defaultHamster = { x: def.x, y: def.y, dir: def.dir, mouth: normalizedMouth };
        for (let i = 0; i < hamsterCells.length; i++) {
            if (i === defaultIndex) continue;
            const h = hamsterCells[i];
            additionalHamsters.push({ x: h.x, y: h.y, dir: h.dir, mouth: 0, color: 0 });
        }
    }

    return { width, height, walls, corn, defaultHamster, additionalHamsters };
}

/**
 * Serializes terrain state back to `.ter` text.
 *
 * `hamsters` must include the default hamster (identified by `id === -1`)
 * and any additional hamsters, each `{x, y, dir, mouth, id}`.
 */
export function serializeTerrainFile({ width, height, walls, corn, hamsters }) {
    const defaultHamster = hamsters.find(h => h.id === -1) || { x: 0, y: 0, dir: DIR_EAST, mouth: 0 };
    const lines = [];
    const cornPositions = [];

    for (let row = 0; row < height; row++) {
        let line = '';
        for (let col = 0; col < width; col++) {
            if (walls[row][col]) {
                line += '#';
                continue;
            }
            const hamster = hamsters.find(h => h.x === col && h.y === row);
            const cornAmount = corn[row][col] || 0;
            if (hamster) {
                line += DIR_CHARS[normalizeDir(hamster.dir)] || '>';
                cornPositions.push({ x: col, y: row });
            } else if (cornAmount > 0) {
                line += '*';
                cornPositions.push({ x: col, y: row });
            } else {
                line += ' ';
            }
        }
        lines.push(line);
    }

    const result = [
        String(width),
        String(height),
        ...lines,
        ...cornPositions.map(p => String(corn[p.y][p.x] || 0)),
        String(defaultHamster.mouth || 0),
    ];
    if (hamsters.length > 1) {
        result.push('@default ' + defaultHamster.x + ' ' + defaultHamster.y);
    }
    return result.join('\n');
}
