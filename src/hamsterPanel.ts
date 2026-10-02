import * as vscode from 'vscode';
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
        const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        const escapedTerrain = escapeAttr(this.options.initialTerrain || '');
        const escapedProgram = escapeAttr(this.options.initialProgram || '');
        const escapedClassSources = escapeAttr(JSON.stringify(this.options.initialClassSources || []));
        const escapedAssetsUri = escapeAttr(assetsUri.toString());

        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   img-src ${webview.cspSource} data:;
                   style-src ${webview.cspSource} 'unsafe-inline';
                   script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hamster Simulator</title>
    <style>
        body {
            margin: 0;
            padding: 8px;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }
        .toolbar {
            display: flex;
            gap: 6px;
            margin-bottom: 8px;
            flex-wrap: wrap;
            align-items: center;
        }
        .toolbar button {
            padding: 4px 12px;
            cursor: pointer;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 2px;
            font-size: 13px;
        }
        .toolbar button:not(:disabled):hover {
            background: var(--vscode-button-hoverBackground);
        }
        .toolbar button:disabled {
            cursor: default;
            opacity: 0.5;
        }
        .toolbar .speed-control,
        .toolbar .zoom-control {
            display: flex;
            align-items: center;
            gap: 4px;
            margin-left: 8px;
        }
        .toolbar .speed-control label {
            font-size: 12px;
            opacity: 0.8;
        }
        .toolbar .speed-control input[type="range"] {
            width: 80px;
        }
        .toolbar .zoom-control span {
            min-width: 36px;
            text-align: center;
        }
        #canvas-container {
            border: 1px solid var(--vscode-panel-border);
            background: #f9f5e7;
            display: block;
            overflow: auto;
            margin-bottom: 8px;
        }
        canvas {
            display: block;
            margin: 0 auto;
        }
        #log {
            max-height: 160px;
            overflow-y: auto;
            padding: 4px 8px;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            border: 1px solid var(--vscode-panel-border);
            background: var(--vscode-editor-background);
        }
        #log .log-error { color: var(--vscode-errorForeground); }
        #terminal-input {
            display: none;
            gap: 6px;
            align-items: center;
            padding: 6px 0;
        }
        #terminal-input.visible { display: flex; }
        #terminal-prompt { flex: 0 1 auto; }
        #terminal-value {
            flex: 1;
            min-width: 80px;
            padding: 3px 5px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, #3a3d41);
        }
        #terminal-input button {
            padding: 4px 10px;
            cursor: pointer;
            color: var(--vscode-button-foreground);
            background: var(--vscode-button-background);
            border: none;
        }
        #status {
            font-size: 12px;
            opacity: 0.8;
            padding: 4px 0;
        }
        .edit-toolbar {
            display: flex;
            gap: 4px;
            margin-bottom: 8px;
            flex-wrap: wrap;
            align-items: center;
            font-size: 12px;
        }
        .edit-toolbar button {
            padding: 3px 8px;
            cursor: pointer;
            background: var(--vscode-button-secondaryBackground, #3a3d41);
            color: var(--vscode-button-secondaryForeground, #ccc);
            border: 1px solid transparent;
            border-radius: 2px;
            font-size: 12px;
        }
        .edit-toolbar button:hover {
            background: var(--vscode-button-secondaryHoverBackground, #454a50);
        }
        .edit-toolbar button.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-color: var(--vscode-focusBorder);
        }
        .edit-toolbar label {
            opacity: 0.8;
            display: flex;
            align-items: center;
            gap: 3px;
        }
        .edit-toolbar input[type="number"] {
            width: 42px;
            padding: 2px 4px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, #3a3d41);
            border-radius: 2px;
            font-size: 12px;
        }
        #hover-info {
            font-size: 11px;
            opacity: 0.7;
            margin-left: 4px;
            min-width: 140px;
        }
    </style>
</head>
<body>
    <div id="initial-data" style="display:none" data-terrain="${escapedTerrain}" data-program="${escapedProgram}" data-class-sources="${escapedClassSources}" data-assets-uri="${escapedAssetsUri}"></div>
    <div class="toolbar">
        <button id="btn-compile" title="Compile">&#10003; Compile</button>
        <button id="btn-run" title="Run">&#9654; Run</button>
        <button id="btn-step" title="Step">&#9193; Step</button>
        <button id="btn-stop" title="Stop">&#9209; Stop</button>
        <button id="btn-reset" title="Reset">&#8634; Reset</button>
        <div class="zoom-control" role="group" aria-label="Zoom">
            <button id="btn-zoom-out" title="Zoom out" aria-label="Zoom out">-</button>
            <span id="zoom-value" aria-live="polite"></span>
            <button id="btn-zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
        </div>
        <div class="speed-control">
            <label for="speed">Speed:</label>
            <input type="range" id="speed" min="50" max="1000" value="400" step="50">
        </div>
    </div>
    <div class="edit-toolbar">
        <label>W <input type="number" id="ter-w" value="10" min="1" max="30"></label>
        <label>H <input type="number" id="ter-h" value="8" min="1" max="20"></label>
        <button id="btn-new-terrain">New</button>
        <span style="opacity:0.4;margin:0 2px">|</span>
        <button class="active" data-tool="wall">Wall</button>
        <button data-tool="erase">Erase</button>
        <button data-tool="corn">Corn</button>
        <button data-tool="hamster">Move</button>
        <button data-tool="rotate">Rotate</button>
        <label>Corn <input type="number" id="corn-amount" value="1" min="0"></label>
        <span id="hover-info">Row -, Col -</span>
    </div>
    <div id="canvas-container">
        <canvas id="terrain" width="480" height="384"></canvas>
    </div>
    <div id="status">Loading...</div>
    <form id="terminal-input">
        <label id="terminal-prompt" for="terminal-value"></label>
        <input id="terminal-value" type="text" autocomplete="off">
        <button type="submit">Enter</button>
    </form>
    <div id="log"></div>

    <!-- Shared language tools bundle (lexer, parser, runner, terrain codec); must load before the simulator bundle, which uses its globals during bootstrap. -->
    <script nonce="${nonce}" src="${langScriptUri}"></script>
    <!-- Simulator engine, runtime adapter, debugger controller, renderer, and UI bootstrap -->
    <script nonce="${nonce}" src="${simulatorScriptUri}"></script>
    <script nonce="${nonce}">
    document.getElementById('status').textContent = 'Ready \u2013 open a .ham file and click Run';
    </script>
</body>
</html>`;
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
