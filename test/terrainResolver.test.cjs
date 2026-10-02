'use strict';
require('../scripts/test-helpers/registerVscodeMock.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { loadTsModule } = require('../scripts/test-helpers/loadTs.cjs');
const vscode = require('../scripts/test-helpers/mockVscode.cjs');

const { resolveTerrain } = loadTsModule('src/terrainResolver.ts');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'hamster-terrain-resolver-'));
}

test('resolveTerrain prefers the .ter file with the same basename as the program', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'foo.ham'), '// program');
    fs.writeFileSync(path.join(dir, 'foo.ter'), 'EXACT MATCH');
    fs.writeFileSync(path.join(dir, 'other.ter'), 'SHOULD NOT BE USED');

    const result = await resolveTerrain(vscode.Uri.file(path.join(dir, 'foo.ham')));
    assert.equal(result, 'EXACT MATCH');
});

test('resolveTerrain falls back to the single .ter file in the folder', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'foo.ham'), '// program');
    fs.writeFileSync(path.join(dir, 'unrelated.ter'), 'UNAMBIGUOUS FALLBACK');

    const result = await resolveTerrain(vscode.Uri.file(path.join(dir, 'foo.ham')));
    assert.equal(result, 'UNAMBIGUOUS FALLBACK');
});

test('resolveTerrain returns undefined when multiple .ter files are ambiguous and none matches exactly', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'foo.ham'), '// program');
    fs.writeFileSync(path.join(dir, 'a.ter'), 'A');
    fs.writeFileSync(path.join(dir, 'b.ter'), 'B');

    const result = await resolveTerrain(vscode.Uri.file(path.join(dir, 'foo.ham')));
    assert.equal(result, undefined);
});

test('resolveTerrain returns undefined when no .ter file exists', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'foo.ham'), '// program');

    const result = await resolveTerrain(vscode.Uri.file(path.join(dir, 'foo.ham')));
    assert.equal(result, undefined);
});

test('resolveTerrain returns undefined when the program folder does not exist', async () => {
    const missingDir = path.join(makeTempDir(), 'does-not-exist');
    const result = await resolveTerrain(vscode.Uri.file(path.join(missingDir, 'foo.ham')));
    assert.equal(result, undefined);
});
