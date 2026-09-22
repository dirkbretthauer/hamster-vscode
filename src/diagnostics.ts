import * as vscode from 'vscode';
import { stripEsModule } from './utils';

interface LanguageToken {
    line: number;
    column: number;
    length?: number;
}

interface LanguageError {
    message?: string;
    token?: LanguageToken;
    line?: number;
    column?: number;
    length?: number;
}

export class HamsterDiagnostics implements vscode.Disposable {
    private collection: vscode.DiagnosticCollection;
    private collectProgramErrors:
        ((source: string, options?: Record<string, unknown>) => LanguageError[]) | null = null;
    private loaded = false;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.collection = vscode.languages.createDiagnosticCollection('hamster');
    }

    private async load(): Promise<void> {
        if (this.loaded) return;
        try {
            const langDir = vscode.Uri.joinPath(this.context.extensionUri, 'lang');
            const decoder = new TextDecoder('utf-8');
            const [lexerRaw, parserRaw] = await Promise.all([
                vscode.workspace.fs.readFile(vscode.Uri.joinPath(langDir, 'hamster-lexer.js')),
                vscode.workspace.fs.readFile(vscode.Uri.joinPath(langDir, 'hamster-parser.js')),
            ]);
            const lexerCode = stripEsModule(decoder.decode(lexerRaw));
            const parserCode = stripEsModule(decoder.decode(parserRaw));
            const combined = lexerCode + '\n' + parserCode + '\nreturn { collectProgramErrors };';
            const factory = new Function(combined);
            const mod = factory() as {
                collectProgramErrors: (
                    source: string,
                    options?: Record<string, unknown>
                ) => LanguageError[];
            };
            this.collectProgramErrors = mod.collectProgramErrors;
            this.loaded = true;
        } catch (e) {
            console.error('Failed to load hamster-parser:', e);
        }
    }

    async update(document: vscode.TextDocument): Promise<void> {
        await this.load();
        if (!this.collectProgramErrors) return;

        let errors: LanguageError[];
        try {
            errors = this.collectProgramErrors(
                document.getText(),
                { requireMain: false }
            );
        } catch (error) {
            console.error('Failed to collect hamster diagnostics:', error);
            this.collection.delete(document.uri);
            return;
        }

        const diagnostics = errors.map(error => {
            const range = createDiagnosticRange(document, error);
            return new vscode.Diagnostic(
                range,
                error.message || String(error),
                vscode.DiagnosticSeverity.Error
            );
        });
        this.collection.set(document.uri, diagnostics);
    }

    dispose() {
        this.collection.dispose();
    }
}

function createDiagnosticRange(
    document: vscode.TextDocument,
    error: LanguageError
): vscode.Range {
    const token = error.token;
    const requestedLine = (token?.line ?? error.line ?? 1) - 1;
    const line = Math.min(Math.max(0, requestedLine), Math.max(0, document.lineCount - 1));
    const lineLength = document.lineAt(line).text.length;
    const requestedColumn = (token?.column ?? error.column ?? 1) - 1;
    const column = Math.min(Math.max(0, requestedColumn), lineLength);
    const start = new vscode.Position(line, column);
    const length = Math.max(0, token?.length ?? error.length ?? 1);
    if (length === 0) {
        return createEndOfFileRange(document, start);
    }
    const endOffset = Math.min(document.getText().length, document.offsetAt(start) + length);
    return new vscode.Range(start, document.positionAt(endOffset));
}

function createEndOfFileRange(
    document: vscode.TextDocument,
    position: vscode.Position
): vscode.Range {
    if (document.getText().length === 0) {
        return new vscode.Range(position, position);
    }
    for (let line = position.line; line >= 0; line -= 1) {
        const lineLength = document.lineAt(line).text.length;
        if (lineLength > 0) {
            return new vscode.Range(
                new vscode.Position(line, lineLength - 1),
                new vscode.Position(line, lineLength)
            );
        }
    }
    return new vscode.Range(position, position);
}
