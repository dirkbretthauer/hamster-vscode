import * as vscode from 'vscode';
import { HamsterPanel, HamsterPanelOptions, stepHighlightDecorationType } from './hamsterPanel';
import { HamsterDiagnostics } from './diagnostics';
import { TerrainEditorProvider } from './terrainEditor';
import { HamsterDebugSession, HamsterDebugConfigurationProvider } from './hamsterDebugSession';
import { resolveTerrain } from './terrainResolver';

let currentPanel: HamsterPanel | undefined;
let panelCreationPromise: Promise<HamsterPanel> | undefined;
let diagnostics: HamsterDiagnostics;

export function activate(context: vscode.ExtensionContext) {
    diagnostics = new HamsterDiagnostics();
    context.subscriptions.push(diagnostics);
    context.subscriptions.push(stepHighlightDecorationType);

    context.subscriptions.push(
        vscode.commands.registerCommand('hamster.openSimulator', async () => {
            const existed = !!currentPanel;
            try {
                const panel = await ensurePanel(context);
                if (existed) {
                    panel.reveal();
                }
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to open Hamster simulator: ${err}`);
            }
        }),

        vscode.commands.registerCommand('hamster.compile', async () => {
            try {
                const panel = await ensurePanel(context);
                panel.postCommand('compile');
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to open Hamster simulator: ${err}`);
            }
        }),

        vscode.commands.registerCommand('hamster.run', async () => {
            try {
                const panel = await ensurePanel(context);
                panel.postCommand('run');
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to open Hamster simulator: ${err}`);
            }
        }),

        vscode.commands.registerCommand('hamster.step', async () => {
            try {
                const panel = await ensurePanel(context);
                panel.postCommand('step');
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to open Hamster simulator: ${err}`);
            }
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
                    currentPanel.sendProgram(e.document.getText(), e.document.uri);
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
                    currentPanel.sendProgram(editor.document.getText(), editor.document.uri);
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

    // Register Hamster debugger
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('hamster', new HamsterDebugConfigurationProvider()),
        vscode.debug.registerDebugAdapterDescriptorFactory('hamster', {
            createDebugAdapterDescriptor: () => {
                const session = new HamsterDebugSession({
                    ensurePanel: () => ensurePanel(context),
                });
                return new vscode.DebugAdapterInlineImplementation(session);
            },
        }),
    );

    // Run diagnostics on already-open .ham files
    Promise.all(
        vscode.workspace.textDocuments
            .filter(doc => doc.languageId === 'hamster')
            .map(doc => diagnostics.update(doc))
    ).catch(err => console.error('initial diagnostics failed:', err));
}

async function createPanel(context: vscode.ExtensionContext): Promise<HamsterPanel> {
    const options: HamsterPanelOptions = {};
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'hamster') {
        options.initialProgram = editor.document.getText();
        options.initialProgramUri = editor.document.uri;
        options.initialTerrain = await resolveTerrain(editor.document.uri);
    }
    return HamsterPanel.create(context, diagnostics, options);
}

// Serializes panel creation so concurrent commands share a single in-flight
// creation and never spawn more than one webview panel.
function ensurePanel(context: vscode.ExtensionContext): Promise<HamsterPanel> {
    if (currentPanel) {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'hamster') {
            currentPanel.sendProgram(editor.document.getText(), editor.document.uri);
            currentPanel.sendTerrain(editor.document.uri).catch(err => console.error('sendTerrain failed:', err));
        }
        return Promise.resolve(currentPanel);
    }
    if (!panelCreationPromise) {
        panelCreationPromise = createPanel(context)
            .then(panel => {
                currentPanel = panel;
                panel.onDidDispose(() => { currentPanel = undefined; });
                return panel;
            })
            .finally(() => { panelCreationPromise = undefined; });
    }
    return panelCreationPromise;
}

export function deactivate() {}
