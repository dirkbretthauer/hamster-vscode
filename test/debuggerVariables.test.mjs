import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const debuggerPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'webview', 'simulator', 'debugger.js');
const GLOBALS_REFERENCE = 1;

async function createController(globals) {
    const source = fs.readFileSync(debuggerPath, 'utf8');
    const { createDebuggerController } = await import(
        'data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    const messages = [];
    const noop = () => {};
    const controller = createDebuggerController({
        vscodeApi: { postMessage: message => messages.push(message) },
        engine: {}, render: noop, getEngineState: () => null,
        getRunnerState: () => ({ scopes: [globals] }), setRunnerState: noop,
        compileProgram: () => false, appendLog: noop, setStatus: noop,
        requestTerminalInput: noop, cancelTerminalInput: noop, stopRunLoop: noop,
        clearLog: noop, setCurrentSource: noop, getSpeedMs: () => 0,
    });
    const variables = reference => {
        controller.sendVariables(messages.length, reference);
        return messages.at(-1).variables;
    };
    return { variables };
}

function hamsterObject(className, fields) {
    return { __kind: 'object', __className: className, fields: Object.assign(Object.create(null), fields) };
}

test('arrays and objects expand into their elements and fields', async () => {
    const counter = hamsterObject('Counter', { total: 7, history: [4, 5] });
    const { variables } = await createController(new Map([
        ['grid', [[1, 2], [3]]], ['counter', counter], ['n', 3],
    ]));

    const [grid, counterVar, n] = variables(GLOBALS_REFERENCE);
    assert.deepEqual([grid.value, counterVar.value, n.value], ['Array(2)', 'Counter', '3']);
    assert.equal(n.variablesReference, 0);

    const rows = variables(grid.variablesReference);
    assert.deepEqual(rows.map(row => [row.name, row.value]), [['0', 'Array(2)'], ['1', 'Array(1)']]);
    assert.deepEqual(variables(rows[0].variablesReference).map(cell => [cell.name, cell.value]),
        [['0', '1'], ['1', '2']]);

    const fields = variables(counterVar.variablesReference);
    assert.deepEqual(fields.map(field => [field.name, field.value]), [['total', '7'], ['history', 'Array(2)']]);
    assert.deepEqual(variables(fields[1].variablesReference).map(item => item.value), ['4', '5']);
});

test('the same value always gets the same reference, distinct values distinct ones', async () => {
    const shared = [1];
    const { variables } = await createController(new Map([['a', shared], ['b', shared], ['c', [1]]]));
    const [a, b, c] = variables(GLOBALS_REFERENCE);
    assert.equal(a.variablesReference, b.variablesReference);
    assert.notEqual(a.variablesReference, c.variablesReference);
});

test('an unknown child reference yields no variables instead of throwing', async () => {
    const { variables } = await createController(new Map());
    assert.deepEqual(variables(123456789), []);
});
