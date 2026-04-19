import * as vscode from 'vscode';
import { stripEsModule } from './utils';

export class HamsterDiagnostics implements vscode.Disposable {
    private collection: vscode.DiagnosticCollection;
    private parseProgram: ((source: string, options?: any) => any) | null = null;
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
            const combined = lexerCode + '\n' + parserCode + '\nreturn { parseProgram };';
            const factory = new Function(combined);
            const mod = factory();
            this.parseProgram = mod.parseProgram;
            this.loaded = true;
        } catch (e) {
            console.error('Failed to load hamster-parser:', e);
        }
    }

    async update(document: vscode.TextDocument): Promise<void> {
        await this.load();
        if (!this.parseProgram) return;

        const diagnostics: vscode.Diagnostic[] = [];
        try {
            this.parseProgram(document.getText(), { compatibility: true, requireMain: false });
        } catch (e: any) {
            const line = (e.token?.line ?? 1) - 1;
            const col = (e.token?.column ?? 1) - 1;
            const range = new vscode.Range(
                new vscode.Position(Math.max(0, line), Math.max(0, col)),
                new vscode.Position(Math.max(0, line), Math.max(0, col) + 10)
            );
            diagnostics.push(new vscode.Diagnostic(range, e.message || String(e), vscode.DiagnosticSeverity.Error));
        }
        this.collection.set(document.uri, diagnostics);
    }

    dispose() {
        this.collection.dispose();
    }
}
