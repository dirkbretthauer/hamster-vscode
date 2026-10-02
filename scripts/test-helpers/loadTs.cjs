'use strict';
/**
 * Loads a TypeScript source file from `src/` as a CommonJS module for tests,
 * without going through the webpack/ts-loader production build. Keeps the
 * unit tests fast and independent of a full extension host.
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '..', '..');

function loadTsModule(relativeSrcPath) {
    const fullPath = path.resolve(repoRoot, relativeSrcPath);
    const source = fs.readFileSync(fullPath, 'utf8');
    const { outputText } = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
            esModuleInterop: true,
        },
        fileName: fullPath,
    });

    const mod = new Module(fullPath, module);
    mod.filename = fullPath;
    mod.paths = Module._nodeModulePaths(path.dirname(fullPath));
    mod._compile(outputText, fullPath);
    return mod.exports;
}

module.exports = { loadTsModule, repoRoot };
