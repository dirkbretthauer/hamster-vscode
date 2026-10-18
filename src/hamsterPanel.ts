import * as vscode from 'vscode';
import { buildSimulatorHtml } from './simulatorHtml';
import { HamsterDiagnostics } from './diagnostics';
import { getNonce, getWebviewLangScriptUri, getWebviewSimulatorScriptUri } from './utils';
import { resolveTerrain } from './terrainResolver';
import { resolveHamsterClassSources } from './hamsterClassResolver';
import {
    DebugHostToPanelMessage,
    DebugPanelToHostMessage,
    HostToPanelMessage,
    SimulatorCommand,
    isDebugMessage,
    isPanelToHostMessage,
} from './webviewProtocol';

export interface HamsterPanelOptions {
    initialTerrain?: string;
    initialProgram?: string;
    initialClassSources?: string[];
    initialProgramUri?: vscode.Uri;
}

export class HamsterPanel {
    private disposables: vscode.Disposable[] = [];
    private _onDidDispose = new vscode.EventEmitter<void>();
    public readonly onDidDispose = this._onDidDispose.event;
    private _onDidReceiveDebugMessage = new vscode.EventEmitter<DebugPanelToHostMessage>();
    public readonly onDidReceiveDebugMessage = this._onDidReceiveDebugMessage.event;
    /** URI of the program currently loaded or being debugged, used to resolve the right editor to highlight. */
    private _programUri: vscode.Uri | undefined;
    private _programLoadVersion = 0;
    /** Editors that currently carry the step highlight decoration, so it can be cleared from all of them. */
    private _decoratedEditors = new Set<vscode.TextEditor>();
    private constructor(
        private context: vscode.ExtensionContext,
        private diagnostics: HamsterDiagnostics,
        private panel: vscode.WebviewPanel,
        private options: HamsterPanelOptions = {},
    ) {
        this._programUri = options.initialProgramUri;
        this.panel.webview.onDidReceiveMessage(
            msg => this.handleMessage(msg),
            null,
            this.disposables
        );

        this.panel.onDidDispose(() => {
            this.cleanUp();
            this._onDidDispose.fire();
        }, null, this.disposables);
    }

    static async create(
        context: vscode.ExtensionContext,
        diagnostics: HamsterDiagnostics,
        options: HamsterPanelOptions = {},
    ): Promise<HamsterPanel> {
        const panel = vscode.window.createWebviewPanel(
            'hamsterSimulator',
            'Hamster Simulator',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview'),
                    vscode.Uri.joinPath(context.extensionUri, 'assets'),
                ],
            }
        );

        const instance = new HamsterPanel(context, diagnostics, panel, options);
        instance.panel.webview.html = instance.getHtmlContent();
        return instance;
    }

    reveal() {
        this.panel.reveal(vscode.ViewColumn.Beside);
    }

    async sendProgram(source: string, uri?: vscode.Uri) {
        const loadVersion = ++this._programLoadVersion;
        const classSources = uri ? await resolveHamsterClassSources(uri) : [];
        if (loadVersion !== this._programLoadVersion) return;
        this.setProgramUri(uri);
        this.post({ type: 'loadProgram', source, classSources });
    }

    /**
     * Records the URI of the program currently loaded or debugged, so step
     * highlighting always targets the matching editor. Switching to a
     * different program clears any highlight left on the previous one.
     */
    setProgramUri(uri: vscode.Uri | undefined) {
        if (this._programUri?.toString() === uri?.toString()) return;
        this._programUri = uri;
        this.clearHighlight();
    }

    async sendTerrain(hamUri: vscode.Uri) {
        const terrain = await resolveTerrain(hamUri);
        if (terrain) {
            this.sendTerrainContent(terrain);
        } else {
            this.resetTerrain();
        }
    }

    sendTerrainContent(content: string) {
        this.post({ type: 'loadTerrain', terrain: content });
    }

    /** Resets the simulator to its default empty terrain, e.g. when no `.ter` file resolves. */
    resetTerrain() {
        this.post({ type: 'resetTerrain' });
    }

    postCommand(command: SimulatorCommand) {
        this.post({ type: 'command', command });
    }

    async saveAllAndRunCommand(command: Extract<SimulatorCommand, 'compile' | 'run' | 'step'>) {
        const saved = await vscode.workspace.saveAll();
        if (!saved) {
            vscode.window.showInformationMessage('Hamster: Operation cancelled because workspace files were not saved.');
            return;
        }

        if (this._programUri) {
            const document = await vscode.workspace.openTextDocument(this._programUri);
            await this.sendProgram(document.getText(), this._programUri);
        }
        this.postCommand(command);
    }

    postDebug(msg: DebugHostToPanelMessage) {
        this.post(msg);
    }

    /** Sends a typed message to the simulator webview. */
    private post(msg: HostToPanelMessage) {
        this.panel.webview.postMessage(msg);
    }

    private handleMessage(msg: unknown) {
        if (isDebugMessage(msg)) {
            if (isPanelToHostMessage(msg)) {
                this._onDidReceiveDebugMessage.fire(msg as DebugPanelToHostMessage);
            } else {
                console.error('Hamster: ignoring malformed debug message from simulator webview:', msg);
            }
            return;
        }
        if (!isPanelToHostMessage(msg)) {
            console.error('Hamster: ignoring malformed message from simulator webview:', msg);
            return;
        }
        switch (msg.type) {
            case 'commandRequest':
                this.saveAllAndRunCommand(msg.command).catch(error => {
                    vscode.window.showErrorMessage(`Hamster: Could not save files before running: ${error}`);
                });
                break;
            case 'error':
                vscode.window.showErrorMessage(`Hamster: ${msg.message}`);
                break;
            case 'info':
                vscode.window.showInformationMessage(`Hamster: ${msg.message}`);
                break;
            case 'highlightLine':
                this.highlightLine(msg.line);
                break;
            case 'clearHighlight':
                this.clearHighlight();
                break;
        }
    }

    private findHamsterEditor(): vscode.TextEditor | undefined {
        if (this._programUri) {
            const programUriString = this._programUri.toString();
            return vscode.window.visibleTextEditors.find(e =>
                e.document.languageId === 'hamster' && e.document.uri.toString() === programUriString
            );
        }
        return vscode.window.visibleTextEditors.find(e => e.document.languageId === 'hamster');
    }

    private highlightLine(line: number) {
        const editor = this.findHamsterEditor();
        if (!editor) return;
        const range = new vscode.Range(line - 1, 0, line - 1, 1000);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        editor.setDecorations(stepHighlight, [{ range }]);
        this._decoratedEditors.add(editor);
    }

    /** Clears the step decoration from every editor it may have been applied to. */
    private clearHighlight() {
        this._decoratedEditors.forEach(editor => editor.setDecorations(stepHighlight, []));
        this._decoratedEditors.clear();
    }

    private getHtmlContent(): string {
        const webview = this.panel.webview;
        const assetsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'assets')
        );
        const langScriptUri = getWebviewLangScriptUri(webview, this.context.extensionUri);
        const simulatorScriptUri = getWebviewSimulatorScriptUri(webview, this.context.extensionUri);
        const nonce = getNonce();
        return buildSimulatorHtml({
            cspSource: webview.cspSource,
            nonce,
            langScriptUri: langScriptUri.toString(),
            simulatorScriptUri: simulatorScriptUri.toString(),
            assetsUri: assetsUri.toString(),
            terrain: this.options.initialTerrain || '',
            program: this.options.initialProgram || '',
            classSources: this.options.initialClassSources || [],
        });
    }

    dispose() {
        this.panel.dispose();
    }

    private cleanUp() {
        this.clearHighlight();
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }
}

/**
 * Decoration used to highlight the line currently being executed. Owned at
 * module scope (one decoration type shared by all panels); the extension
 * disposes it on deactivation via `stepHighlightDecorationType`.
 */
export const stepHighlightDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    isWholeLine: true,
});
const stepHighlight = stepHighlightDecorationType;
