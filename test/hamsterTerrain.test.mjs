import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTerrainFile, serializeTerrainFile } from '../lang/hamster-terrain.js';

/** Builds the `hamsters` array shape `serializeTerrainFile` expects from a parsed terrain. */
function hamstersFromParsed(parsed) {
    return [
        { id: -1, ...parsed.defaultHamster },
        ...parsed.additionalHamsters.map((h, i) => ({ id: i, ...h })),
    ];
}

test('parseTerrainFile returns null for missing/invalid width or height', () => {
    assert.equal(parseTerrainFile(''), null);
    assert.equal(parseTerrainFile('not-a-number\n8\n'), null);
    assert.equal(parseTerrainFile('0\n8\n'), null);
    assert.equal(parseTerrainFile('3\n-1\n'), null);
});

test('parseTerrainFile reads walls, corn piles and the default hamster', () => {
    // Every '*' or hamster cell consumes one corn-amount line, in row-major order.
    const ter = [
        '3', '2',
        '#* ',
        ' >#',
        '1', // corn amount for the '*' cell at (row0, col1)
        '0', // corn amount for the hamster cell at (row1, col1)
        '2', // default hamster mouth count
    ].join('\n');

    const parsed = parseTerrainFile(ter);
    assert.equal(parsed.width, 3);
    assert.equal(parsed.height, 2);
    assert.deepEqual(parsed.walls, [[1, 0, 0], [0, 0, 1]]);
    assert.deepEqual(parsed.corn, [[0, 1, 0], [0, 0, 0]]);
    assert.deepEqual(parsed.defaultHamster, { x: 1, y: 1, dir: 1, mouth: 2 });
    assert.deepEqual(parsed.additionalHamsters, []);
});

test('parseTerrainFile selects the @default-marked hamster among several and preserves the rest', () => {
    const ter = [
        '4', '1',
        '^ v<',
        '0', // corn amount for the '^' cell
        '0', // corn amount for the 'v' cell
        '0', // corn amount for the '<' cell
        '5', // default hamster mouth
        '@default 3 0', // the '<' hamster (col 3, row 0) is the default
    ].join('\n');

    const parsed = parseTerrainFile(ter);
    assert.deepEqual(parsed.defaultHamster, { x: 3, y: 0, dir: 3, mouth: 5 });
    assert.equal(parsed.additionalHamsters.length, 2);
    assert.deepEqual(
        parsed.additionalHamsters.map(h => ({ x: h.x, y: h.y, dir: h.dir })),
        [{ x: 0, y: 0, dir: 0 }, { x: 2, y: 0, dir: 2 }],
    );
});

test('serializeTerrainFile(parseTerrainFile(x)) round-trips walls, corn, direction and mouth count', () => {
    const original = ['2', '2', '#*', ' >', '3', '0', '4'].join('\n');
    const parsed = parseTerrainFile(original);
    const serialized = serializeTerrainFile({
        width: parsed.width,
        height: parsed.height,
        walls: parsed.walls,
        corn: parsed.corn,
        hamsters: hamstersFromParsed(parsed),
    });
    assert.equal(serialized, original);
});

test('round-trip preserves multiple hamsters and emits an @default line', () => {
    const original = ['3', '1', '^ <', '0', '7', '5', '@default 2 0'].join('\n');
    const parsed = parseTerrainFile(original);
    const serialized = serializeTerrainFile({
        width: parsed.width,
        height: parsed.height,
        walls: parsed.walls,
        corn: parsed.corn,
        hamsters: hamstersFromParsed(parsed),
    });
    assert.equal(serialized, original);
});

test('serializeTerrainFile omits the @default line when there is only one hamster', () => {
    const serialized = serializeTerrainFile({
        width: 2, height: 1,
        walls: [[0, 0]], corn: [[0, 0]],
        hamsters: [{ id: -1, x: 0, y: 0, dir: 1, mouth: 0 }],
    });
    assert.equal(serialized, '2\n1\n> \n0\n0');
});
