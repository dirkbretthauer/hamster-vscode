'use strict';
require('../scripts/test-helpers/registerVscodeMock.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { loadTsModule } = require('../scripts/test-helpers/loadTs.cjs');
const vscode = require('../scripts/test-helpers/mockVscode.cjs');
const { resolveHamsterClassSources } = loadTsModule('src/hamsterClassResolver.ts');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'hamster-class-resolver-'));
}

test('resolveHamsterClassSources finds nested standalone class programs only', async () => {
    const root = makeTempDir();
    const nested = path.join(root, 'helpers', 'nested');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'main.ham'), '/*object-oriented program*/ void main() {}');
    fs.writeFileSync(path.join(root, 'Helper.ham'), '/*class*/ class Helper {}');
    fs.writeFileSync(path.join(nested, 'More.ham'), '/*class*/ class More {}');
    fs.writeFileSync(path.join(nested, 'OtherProgram.ham'), 'void main() {}');
    fs.writeFileSync(path.join(root, 'node_modules', 'Ignored.ham'), '/*class*/ class Ignored {}');

    const sources = await resolveHamsterClassSources(vscode.Uri.file(path.join(root, 'main.ham')));

    assert.deepEqual(sources, [
        '/*class*/ class Helper {}',
        '/*class*/ class More {}',
    ]);
});