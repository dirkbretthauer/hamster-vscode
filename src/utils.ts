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
