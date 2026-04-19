import * as vscode from 'vscode';
import { HamsterPanel, HamsterPanelOptions } from './hamsterPanel';
import { HamsterDiagnostics } from './diagnostics';
import { TerrainEditorProvider } from './terrainEditor';

let currentPanel: HamsterPanel | undefined;
let diagnostics: HamsterDiagnostics;

export function activate(context: vscode.ExtensionContext) {
    diagnostics = new HamsterDiagnostics(context);
    context.subscriptions.push(diagnostics);

    context.subscriptions.push(
        vscode.commands.registerCommand('hamster.openSimulator', () => {
            const existed = !!currentPanel;
            ensurePanel(context);
            if (existed) {
                currentPanel!.reveal();
            }
        }),

        vscode.commands.registerCommand('hamster.run', () => {
            ensurePanel(context);
            currentPanel!.postCommand('run');
        }),

        vscode.commands.registerCommand('hamster.step', () => {
            ensurePanel(context);
            currentPanel!.postCommand('step');
        }),

        vscode.commands.registerCommand('hamster.stop', () => {
            currentPanel?.postCommand('stop');
        }),

        vscode.commands.registerCommand('hamster.reset', () => {
            currentPanel?.postCommand('reset');
        }),

        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.languageId === 'hamster') {
                diagnostics.update(e.document).catch(err => console.error('diagnostics update failed:', err));
                if (currentPanel) {
                    currentPanel.sendProgram(e.document.getText());
                }
            }
        }),

        vscode.workspace.onDidOpenTextDocument(doc => {
            if (doc.languageId === 'hamster') {
                diagnostics.update(doc).catch(err => console.error('diagnostics update failed:', err));
            }
        }),

        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (!editor) return;
            if (editor.document.languageId === 'hamster') {
                diagnostics.update(editor.document).catch(err => console.error('diagnostics update failed:', err));
                if (currentPanel) {
                    currentPanel.sendProgram(editor.document.getText());
                    currentPanel.sendTerrain(editor.document.uri).catch(err => console.error('sendTerrain failed:', err));
                }
            }
        }),
    );

    // Register custom editor for .ter files
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            TerrainEditorProvider.viewType,
            new TerrainEditorProvider(context),
        )
    );

    // Run diagnostics on already-open .ham files
    Promise.all(
        vscode.workspace.textDocuments
            .filter(doc => doc.languageId === 'hamster')
            .map(doc => diagnostics.update(doc))
    ).catch(err => console.error('initial diagnostics failed:', err));
}

async function ensurePanel(context: vscode.ExtensionContext) {
    if (!currentPanel) {
        const options: HamsterPanelOptions = {};
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'hamster') {
            options.initialProgram = editor.document.getText();
            const hamUri = editor.document.uri;
            const dirUri = vscode.Uri.joinPath(hamUri, '..');
            const uriPath = hamUri.path;
            const lastSlash = uriPath.lastIndexOf('/');
            const fileName = uriPath.substring(lastSlash + 1);
            const baseName = fileName.endsWith('.ham') ? fileName.slice(0, -4) : fileName;
            const exactTerUri = vscode.Uri.joinPath(dirUri, baseName + '.ter');
            const decoder = new TextDecoder('utf-8');
            try {
                const data = await vscode.workspace.fs.readFile(exactTerUri);
                options.initialTerrain = decoder.decode(data);
            } catch {
                try {
                    const entries = await vscode.workspace.fs.readDirectory(dirUri);
                    const terEntry = entries.find(([name]) => name.endsWith('.ter'));
                    if (terEntry) {
                        const data = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dirUri, terEntry[0]));
                        options.initialTerrain = decoder.decode(data);
                    }
                } catch { /* ignore */ }
            }
        }
        currentPanel = await HamsterPanel.create(context, diagnostics, options);
        currentPanel.onDidDispose(() => { currentPanel = undefined; });
        return;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'hamster') {
        currentPanel.sendProgram(editor.document.getText());
        currentPanel.sendTerrain(editor.document.uri).catch(err => console.error('sendTerrain failed:', err));
    }
}

export function deactivate() {}
