'use strict';
/**
 * Registers the lightweight `vscode` mock so `require('vscode')` resolves to
 * it for the lifetime of the current (isolated, per-test-file) process. Node's
 * test runner spawns a fresh process per test file, so this doesn't leak into
 * other suites.
 */
const Module = require('node:module');
const vscodeMock = require('./mockVscode.cjs');

const VIRTUAL_ID = '\0hamster-vscode-mock';

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === 'vscode') return VIRTUAL_ID;
    return originalResolveFilename.call(this, request, ...args);
};

require.cache[VIRTUAL_ID] = {
    id: VIRTUAL_ID,
    filename: VIRTUAL_ID,
    loaded: true,
    exports: vscodeMock,
};

module.exports = vscodeMock;
