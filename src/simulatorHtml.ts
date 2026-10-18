export interface SimulatorHtmlParams {
    cspSource: string;
    nonce: string;
    langScriptUri: string;
    simulatorScriptUri: string;
    assetsUri: string;
    terrain: string;
    program: string;
    classSources: string[];
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Pure (vscode-free) so the browser preview server can render the same shell the panel uses. */
export function buildSimulatorHtml(params: SimulatorHtmlParams): string {
    const { cspSource, nonce, langScriptUri, simulatorScriptUri } = params;
    const escapedTerrain = escapeAttr(params.terrain);
    const escapedProgram = escapeAttr(params.program);
    const escapedClassSources = escapeAttr(JSON.stringify(params.classSources));
    const escapedAssetsUri = escapeAttr(params.assetsUri);

    return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   img-src ${cspSource} data:;
                   style-src ${cspSource} 'unsafe-inline';
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
