import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
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

function ensurePanel(context: vscode.ExtensionContext) {
    if (!currentPanel) {
        const options: HamsterPanelOptions = {};
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'hamster') {
            options.initialProgram = editor.document.getText();
            const dir = path.dirname(editor.document.uri.fsPath);
            const baseName = path.basename(editor.document.uri.fsPath, '.ham');
            const exactTer = path.join(dir, baseName + '.ter');
            try {
                options.initialTerrain = fs.readFileSync(exactTer, 'utf-8');
            } catch {
                try {
                    const files = fs.readdirSync(dir);
                    const terFile = files.find(f => f.endsWith('.ter'));
                    if (terFile) {
                        options.initialTerrain = fs.readFileSync(path.join(dir, terFile), 'utf-8');
                    }
                } catch { /* ignore */ }
            }
        }
        currentPanel = new HamsterPanel(context, diagnostics, options);
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
