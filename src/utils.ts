import * as fs from 'fs';
import * as path from 'path';

export function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

export function stripEsModule(code: string): string {
    return code
        .replace(/^export\s+(const|class|function)\s+/gm, '$1 ')
        .replace(/^export\s+\{[^}]*\};?\s*$/gm, '')
        .replace(/^import\s+.*$/gm, '');
}

export interface LangScripts {
    lexerCode: string;
    parserCode: string;
    runnerCode: string;
}

let cachedScripts: LangScripts | null = null;

/** Loads and caches the language scripts. Sync read on first call only (small files). */
export function loadLangScripts(extensionPath: string): LangScripts {
    if (cachedScripts) return cachedScripts;

    const langDir = path.join(extensionPath, 'lang');
    cachedScripts = {
        lexerCode: stripEsModule(fs.readFileSync(path.join(langDir, 'hamster-lexer.js'), 'utf-8')),
        parserCode: stripEsModule(fs.readFileSync(path.join(langDir, 'hamster-parser.js'), 'utf-8')),
        runnerCode: stripEsModule(fs.readFileSync(path.join(langDir, 'hamster-runner.js'), 'utf-8')),
    };
    return cachedScripts;
}
