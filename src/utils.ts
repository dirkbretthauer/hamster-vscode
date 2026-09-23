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

export interface LanguageError {
    message?: string;
    token?: {
        line: number;
        column: number;
        length?: number;
    };
    line?: number;
    column?: number;
    length?: number;
}

export interface LanguageModule {
    collectProgramErrors: (
        source: string,
        options?: Record<string, unknown>
    ) => LanguageError[];
    parseProgram: (
        source: string,
        options?: Record<string, unknown>
    ) => Record<string, unknown>;
    collectExecutableLines: (ast: Record<string, unknown>) => number[];
    findExecutableLineAtOrAfter: (
        requestedLine: number,
        executableLines: number[]
    ) => number | null;
}

let cachedLanguageModule: LanguageModule | null = null;

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

export async function loadLanguageModule(extensionUri: vscode.Uri): Promise<LanguageModule> {
    if (cachedLanguageModule) return cachedLanguageModule;

    const { lexerCode, parserCode } = await loadLangScripts(extensionUri);
    const combined = lexerCode + '\n' + parserCode +
        '\nreturn { collectProgramErrors, parseProgram, collectExecutableLines, ' +
        'findExecutableLineAtOrAfter };';
    const factory = new Function(combined);
    cachedLanguageModule = factory() as LanguageModule;
    return cachedLanguageModule;
}
