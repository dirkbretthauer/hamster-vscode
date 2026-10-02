'use strict';
/**
 * Minimal, filesystem-backed stand-in for the `vscode` module, covering only
 * the surface `terrainResolver.ts` uses (`Uri.file`/`Uri.joinPath` and
 * `workspace.fs.readFile`/`readDirectory`). Lets that pure helper be unit
 * tested against a real temp directory without a full Extension Host.
 */
const fs = require('node:fs');
const path = require('node:path');

function makeUri(fsPath) {
    return {
        fsPath,
        path: fsPath.split(path.sep).join('/'),
        toString() {
            return 'file://' + this.path;
        },
    };
}

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

const vscode = {
    FileType,
    Uri: {
        file: p => makeUri(p),
        joinPath: (base, ...segments) => makeUri(path.join(base.fsPath, ...segments)),
    },
    workspace: {
        fs: {
            async readFile(uri) {
                return new Uint8Array(fs.readFileSync(uri.fsPath));
            },
            async readDirectory(uri) {
                const entries = fs.readdirSync(uri.fsPath, { withFileTypes: true });
                return entries.map(entry => [
                    entry.name,
                    entry.isDirectory() ? FileType.Directory : FileType.File,
                ]);
            },
        },
    },
};

module.exports = vscode;
