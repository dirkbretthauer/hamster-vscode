import * as vscode from 'vscode';

export function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

/**
 * URI of the bundled language-tools script (lexer, parser, runner, terrain
 * codec) built from `src/webview/langBundleEntry.js` into
 * `dist/webview/hamster-lang.js`. Loaded by the simulator and terrain editor
 * webviews via a `<script src>` tag so they share one real module bundle
 * instead of each inlining a separately re-read, stripped copy of the source.
 */
export function getWebviewLangScriptUri(webview: vscode.Webview, extensionUri: vscode.Uri): vscode.Uri {
    return webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'hamster-lang.js')
    );
}

/**
 * URI of the bundled simulator webview script (engine, runtime adapter,
 * debugger controller, renderer, and UI bootstrap) built from
 * `src/webview/simulator/index.js` into `dist/webview/hamster-simulator.js`.
 * Loaded by `hamsterPanel.ts`'s webview via a `<script src>` tag.
 */
export function getWebviewSimulatorScriptUri(webview: vscode.Webview, extensionUri: vscode.Uri): vscode.Uri {
    return webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'hamster-simulator.js')
    );
}

/**
 * URI of the bundled terrain editor webview script (engine, renderer, and
 * UI bootstrap) built from `src/webview/terrainEditor/index.js` into
 * `dist/webview/hamster-terrain-editor.js`. Loaded by `terrainEditor.ts`'s
 * webview via a `<script src>` tag.
 */
export function getWebviewTerrainEditorScriptUri(webview: vscode.Webview, extensionUri: vscode.Uri): vscode.Uri {
    return webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'hamster-terrain-editor.js')
    );
}
