import * as vscode from 'vscode';
import { getNonce, getWebviewLangScriptUri, getWebviewTerrainEditorScriptUri } from './utils';
import { HostToTerrainEditorMessage, isTerrainEditorToHostMessage } from './webviewProtocol';

export class TerrainEditorProvider implements vscode.CustomTextEditorProvider {
    public static readonly viewType = 'hamster.terrainEditor';

    constructor(private readonly context: vscode.ExtensionContext) {}

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken,
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
                vscode.Uri.joinPath(this.context.extensionUri, 'assets'),
            ],
        };

        const assetsUri = webviewPanel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'assets')
        );

        const escapedTerrain = document.getText()
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

        const nonce = getNonce();
        const langScriptUri = getWebviewLangScriptUri(webviewPanel.webview, this.context.extensionUri);
        const terrainEditorScriptUri = getWebviewTerrainEditorScriptUri(webviewPanel.webview, this.context.extensionUri);

        webviewPanel.webview.html = this.getHtml(
            webviewPanel.webview, nonce, assetsUri.toString(),
            escapedTerrain, langScriptUri.toString(), terrainEditorScriptUri.toString(),
        );

        // Track the last content we sent to the document to prevent circular updates
        let lastWebviewContent = '';

        webviewPanel.webview.onDidReceiveMessage(async msg => {
            if (!isTerrainEditorToHostMessage(msg)) {
                console.error('Hamster: ignoring malformed message from terrain editor webview:', msg);
                return;
            }
            lastWebviewContent = msg.content;
            await this.updateDocument(document, msg.content);
        });

        // When the document changes externally (e.g. git, undo), reload in the webview
        const changeSubscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() !== document.uri.toString() || e.contentChanges.length === 0) return;
            const currentText = document.getText();
            if (currentText === lastWebviewContent) return;
            this.postMessage(webviewPanel, { type: 'loadTerrain', terrain: currentText });
        });
        webviewPanel.onDidDispose(() => changeSubscription.dispose());
    }

    private postMessage(webviewPanel: vscode.WebviewPanel, msg: HostToTerrainEditorMessage) {
        webviewPanel.webview.postMessage(msg);
    }

    private async updateDocument(document: vscode.TextDocument, content: string) {
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            new vscode.Position(0, 0),
            document.lineAt(document.lineCount - 1).range.end,
        );
        edit.replace(document.uri, fullRange, content);
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            vscode.window.showErrorMessage('Hamster: failed to save terrain changes to the document.');
        }
    }

    private getHtml(
        webview: vscode.Webview, nonce: string, assetsUri: string,
        escapedTerrain: string, langScriptUri: string, terrainEditorScriptUri: string,
    ): string {
        const escapedAssetsUri = assetsUri.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
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
    <title>Terrain Editor</title>
    <style>
        body {
            margin: 0; padding: 8px;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }
        .edit-toolbar {
            display: flex; gap: 4px; margin-bottom: 8px;
            flex-wrap: wrap; align-items: center; font-size: 12px;
        }
        .edit-toolbar button {
            padding: 3px 8px; cursor: pointer;
            background: var(--vscode-button-secondaryBackground, #3a3d41);
            color: var(--vscode-button-secondaryForeground, #ccc);
            border: 1px solid transparent; border-radius: 2px; font-size: 12px;
        }
        .edit-toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground, #454a50); }
        .edit-toolbar button.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-color: var(--vscode-focusBorder);
        }
        .edit-toolbar label { opacity: 0.8; display: flex; align-items: center; gap: 3px; }
        .edit-toolbar input[type="number"] {
            width: 42px; padding: 2px 4px;
            background: var(--vscode-input-background); color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, #3a3d41); border-radius: 2px; font-size: 12px;
        }
        #hover-info { font-size: 11px; opacity: 0.7; margin-left: 4px; min-width: 140px; }
        #canvas-container {
            border: 1px solid var(--vscode-panel-border);
            background: #f9f5e7; display: inline-block;
        }
        canvas { display: block; }
    </style>
</head>
<body>
    <div id="initial-data" style="display:none" data-terrain="${escapedTerrain}" data-assets-uri="${escapedAssetsUri}"></div>
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
        <label>Mouth <input type="number" id="hamster-mouth" value="0" min="0"></label>
        <span id="hover-info">Row -, Col -</span>
    </div>
    <div id="canvas-container">
        <canvas id="terrain" width="480" height="384"></canvas>
    </div>

    <!-- Shared terrain parse/serialize helpers (also used by the simulator webview) -->
    <script nonce="${nonce}" src="${langScriptUri}"></script>
    <!-- Terrain editor engine, renderer, and UI bootstrap -->
    <script nonce="${nonce}" src="${terrainEditorScriptUri}"></script>
</body>
</html>`;
    }
}
