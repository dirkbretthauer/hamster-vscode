import * as vscode from 'vscode';

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

/** Loads and caches the language scripts. Async read using vscode.workspace.fs. */
export async function loadLangScripts(extensionUri: vscode.Uri): Promise<LangScripts> {
    if (cachedScripts) return cachedScripts;

    const langDir = vscode.Uri.joinPath(extensionUri, 'lang');
    const decoder = new TextDecoder('utf-8');
    const [lexerRaw, parserRaw, runnerRaw] = await Promise.all([
        vscode.workspace.fs.readFile(vscode.Uri.joinPath(langDir, 'hamster-lexer.js')),
        vscode.workspace.fs.readFile(vscode.Uri.joinPath(langDir, 'hamster-parser.js')),
        vscode.workspace.fs.readFile(vscode.Uri.joinPath(langDir, 'hamster-runner.js')),
    ]);
    cachedScripts = {
        lexerCode: stripEsModule(decoder.decode(lexerRaw)),
        parserCode: stripEsModule(decoder.decode(parserRaw)),
        runnerCode: stripEsModule(decoder.decode(runnerRaw)),
    };
    return cachedScripts;
}
