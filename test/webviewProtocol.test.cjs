'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');

const { loadTsModule } = require('../scripts/test-helpers/loadTs.cjs');

const {
    isDebugMessage,
    isPanelToHostMessage,
    isTerrainEditorToHostMessage,
    isSimulatorCommand,
} = loadTsModule('src/webviewProtocol.ts');

test('isDebugMessage accepts any dbg:* prefixed message, valid or not', () => {
    assert.equal(isDebugMessage({ type: 'dbg:stopped', reason: 'step' }), true);
    assert.equal(isDebugMessage({ type: 'dbg:bogus' }), true);
    assert.equal(isDebugMessage({ type: 'error' }), false);
    assert.equal(isDebugMessage(null), false);
    assert.equal(isDebugMessage('dbg:stopped'), false);
    assert.equal(isDebugMessage(undefined), false);
});

test('isPanelToHostMessage accepts well-formed simulator-webview messages', () => {
    assert.equal(isPanelToHostMessage({ type: 'error', message: 'oops' }), true);
    assert.equal(isPanelToHostMessage({ type: 'info', message: 'ok' }), true);
    assert.equal(isPanelToHostMessage({ type: 'commandRequest', command: 'compile' }), true);
    assert.equal(isPanelToHostMessage({ type: 'commandRequest', command: 'run' }), true);
    assert.equal(isPanelToHostMessage({ type: 'commandRequest', command: 'step' }), true);
    assert.equal(isPanelToHostMessage({ type: 'highlightLine', line: 3 }), true);
    assert.equal(isPanelToHostMessage({ type: 'clearHighlight' }), true);
    assert.equal(isPanelToHostMessage({ type: 'dbg:stopped', reason: 'breakpoint', threadId: 1, line: 2 }), true);
    assert.equal(isPanelToHostMessage({ type: 'dbg:terminated' }), true);
    assert.equal(isPanelToHostMessage({ type: 'dbg:output', output: 'hi' }), true);
    assert.equal(isPanelToHostMessage({ type: 'dbg:output', output: 'hi', threadId: 3 }), true);
    assert.equal(isPanelToHostMessage({ type: 'dbg:stackTrace', requestId: 1, threadId: 1, frames: [] }), true);
    assert.equal(isPanelToHostMessage({ type: 'dbg:scopes', requestId: 1, scopes: [] }), true);
    assert.equal(isPanelToHostMessage({ type: 'dbg:variables', requestId: 1, variables: [] }), true);
    assert.equal(isPanelToHostMessage({ type: 'dbg:evaluate', requestId: 1, result: '42' }), true);
    assert.equal(isPanelToHostMessage({ type: 'dbg:evaluate', requestId: 1, error: 'bad expr' }), true);
    // Multi-threaded debugging messages (003-cooperative-threads).
    assert.equal(isPanelToHostMessage({ type: 'dbg:threadStarted', threadId: 2, name: 'FrissHamster' }), true);
    assert.equal(isPanelToHostMessage({ type: 'dbg:threadExited', threadId: 2 }), true);
    assert.equal(isPanelToHostMessage({ type: 'dbg:threads', requestId: 1, threads: [] }), true);
    assert.equal(isPanelToHostMessage({
        type: 'dbg:threads',
        requestId: 1,
        threads: [{ id: 1, name: 'main', status: 'runnable' }],
    }), true);
    assert.equal(isPanelToHostMessage({
        type: 'dbg:threads',
        requestId: 1,
        threads: [{ id: 2, name: 'Paul', status: 'waiting', detail: 'suspended in wait()' }],
    }), true);
});

test('isPanelToHostMessage rejects thread messages missing or mistyping a threadId', () => {
    assert.equal(isPanelToHostMessage({ type: 'dbg:stopped', reason: 'step' }), false, 'threadId required');
    assert.equal(isPanelToHostMessage({ type: 'dbg:stopped', reason: 'step', threadId: '1' }), false);
    assert.equal(isPanelToHostMessage({ type: 'dbg:stackTrace', requestId: 1, frames: [] }), false, 'threadId required');
    assert.equal(isPanelToHostMessage({ type: 'dbg:threadStarted', threadId: 2 }), false, 'name required');
    assert.equal(isPanelToHostMessage({ type: 'dbg:threadStarted', name: 'Paul' }), false, 'threadId required');
    assert.equal(isPanelToHostMessage({ type: 'dbg:threadExited' }), false);
    assert.equal(isPanelToHostMessage({ type: 'dbg:threads', requestId: 1 }), false, 'threads array required');
    assert.equal(isPanelToHostMessage({ type: 'dbg:threads', requestId: 1, threads: 'nope' }), false);
    assert.equal(isPanelToHostMessage({
        type: 'dbg:threads', requestId: 1, threads: [{ id: 1, name: 'main' }],
    }), false, 'status required on each thread');
    assert.equal(isPanelToHostMessage({
        type: 'dbg:threads', requestId: 1, threads: [{ id: '1', name: 'main', status: 'runnable' }],
    }), false, 'id must be a number');
    assert.equal(isPanelToHostMessage({
        type: 'dbg:threads', requestId: 1, threads: [{ id: 1, name: 'main', status: 'runnable', detail: 7 }],
    }), false, 'detail must be a string when present');
    assert.equal(isPanelToHostMessage({ type: 'dbg:output', output: 'hi', threadId: 'x' }), false);
});

test('isPanelToHostMessage rejects malformed or unknown simulator-webview messages', () => {
    assert.equal(isPanelToHostMessage(null), false);
    assert.equal(isPanelToHostMessage(undefined), false);
    assert.equal(isPanelToHostMessage('error'), false);
    assert.equal(isPanelToHostMessage({}), false);
    assert.equal(isPanelToHostMessage({ type: 'error' }), false, 'missing message field');
    assert.equal(isPanelToHostMessage({ type: 'commandRequest', command: 'stop' }), false);
    assert.equal(isPanelToHostMessage({ type: 'commandRequest' }), false);
    assert.equal(isPanelToHostMessage({ type: 'error', message: 42 }), false, 'wrong message type');
    assert.equal(isPanelToHostMessage({ type: 'highlightLine', line: '3' }), false, 'line must be a number');
    assert.equal(isPanelToHostMessage({ type: 'dbg:stackTrace', requestId: 1, frames: 'nope' }), false);
    assert.equal(isPanelToHostMessage({ type: 'dbg:evaluate', requestId: 1, result: 42 }), false);
    assert.equal(isPanelToHostMessage({ type: 'notARealType' }), false);
    assert.equal(isPanelToHostMessage({ type: '__proto__' }), false);
});

test('isTerrainEditorToHostMessage accepts only well-formed terrainChanged payloads', () => {
    assert.equal(isTerrainEditorToHostMessage({ type: 'terrainChanged', content: '10\n8\n' }), true);
    assert.equal(isTerrainEditorToHostMessage({ type: 'terrainChanged', content: '' }), true);
});

test('isTerrainEditorToHostMessage rejects malformed or unknown terrain-editor messages', () => {
    assert.equal(isTerrainEditorToHostMessage(null), false);
    assert.equal(isTerrainEditorToHostMessage({}), false);
    assert.equal(isTerrainEditorToHostMessage({ type: 'terrainChanged' }), false, 'missing content');
    assert.equal(isTerrainEditorToHostMessage({ type: 'terrainChanged', content: 123 }), false, 'content must be a string');
    assert.equal(isTerrainEditorToHostMessage({ type: 'loadTerrain', terrain: 'x' }), false, 'wrong type');
});

test('isSimulatorCommand accepts only the known simulator commands', () => {
    for (const command of ['compile', 'run', 'step', 'stop', 'reset']) {
        assert.equal(isSimulatorCommand(command), true);
    }
    assert.equal(isSimulatorCommand('launch'), false);
    assert.equal(isSimulatorCommand(''), false);
    assert.equal(isSimulatorCommand(42), false);
    assert.equal(isSimulatorCommand(null), false);
});
