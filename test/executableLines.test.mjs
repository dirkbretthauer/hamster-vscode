import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProgram, collectExecutableLines, findExecutableLineAtOrAfter } from '../lang/hamster-parser.js';

function programLines(ast) {
    return collectExecutableLines(ast);
}

test('collectExecutableLines finds statements nested in if/while/switch/try', () => {
    const source = [
        /* 1 */ 'void main() {',
        /* 2 */ '  if (true) {',
        /* 3 */ '    vor();',
        /* 4 */ '  } else {',
        /* 5 */ '    linksUm();',
        /* 6 */ '  }',
        /* 7 */ '  while (true) {',
        /* 8 */ '    nimm();',
        /* 9 */ '  }',
        /*10 */ '  switch (1) {',
        /*11 */ '    case 1:',
        /*12 */ '      gib();',
        /*13 */ '      break;',
        /*14 */ '  }',
        /*15 */ '  try {',
        /*16 */ '    vor();',
        /*17 */ '  } catch (HamsterException error) {',
        /*18 */ '    linksUm();',
        /*19 */ '  }',
        /*20 */ '}',
    ].join('\n');

    const ast = parseProgram(source);
    const lines = programLines(ast);

    for (const expected of [3, 5, 8, 12, 13, 16, 18]) {
        assert.ok(lines.includes(expected), `expected line ${expected} to be executable, got [${lines}]`);
    }
});

test('collectExecutableLines finds statements inside a desugared for-loop body', () => {
    const source = [
        /* 1 */ 'void main() {',
        /* 2 */ '  for (int i = 0; i < 3; i++) {',
        /* 3 */ '    if (kornDa()) {',
        /* 4 */ '      nimm();',
        /* 5 */ '    }',
        /* 6 */ '    vor();',
        /* 7 */ '  }',
        /* 8 */ '}',
    ].join('\n');

    const ast = parseProgram(source);
    const lines = programLines(ast);

    // Regression guard: `for` loops are desugared into Block([initializer, WhileStatement]),
    // so the body's statements must still surface as executable lines.
    for (const expected of [4, 6]) {
        assert.ok(lines.includes(expected), `expected line ${expected} to be executable, got [${lines}]`);
    }
});

test('findExecutableLineAtOrAfter snaps a requested breakpoint line forward to the next executable line', () => {
    const executableLines = [3, 6, 8];
    assert.equal(findExecutableLineAtOrAfter(3, executableLines), 3);
    assert.equal(findExecutableLineAtOrAfter(4, executableLines), 6);
    assert.equal(findExecutableLineAtOrAfter(7, executableLines), 8);
    assert.equal(findExecutableLineAtOrAfter(9, executableLines), null);
});
