#!/usr/bin/env node
// Browser preview of the simulator webview without VS Code: serves the real HTML shell and
// dist/webview bundles, with a tiny acquireVsCodeApi shim. Usage: node scripts/preview-server.mjs [port]
// Run `npm run compile` first. Pick a program with ?sample=<name> (see test/fixtures/simulation).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSimulatorHtml } from '../src/simulatorHtml.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const samplesDir = path.join(root, 'test', 'fixtures', 'simulation');
const port = Number(process.argv[2] || process.env.PORT || 4173);
const MIME = { '.js': 'text/javascript', '.map': 'application/json', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

const THEME = `
:root { --vscode-font-family: system-ui, sans-serif; --vscode-font-size: 13px; --vscode-foreground: #ccc;
  --vscode-editor-background: #1e1e1e; --vscode-button-background: #0e639c; --vscode-button-foreground: #fff;
  --vscode-button-hoverBackground: #1177bb; --vscode-input-background: #3c3c3c; --vscode-input-foreground: #ccc; }`;

// Host stand-in: toolbar buttons post `commandRequest`, which the real host turns into a `command` message.
const SHIM = `window.__hostMessages = [];
window.acquireVsCodeApi = () => ({
  postMessage(msg) {
    window.__hostMessages.push(msg);
    if (msg.type === 'commandRequest') window.postMessage({ type: 'command', command: msg.command }, '*');
    else console.log('[host]', msg);
  },
  getState() { return undefined; }, setState() {}
});`;

function readSample(name) {
  const base = path.join(samplesDir, path.basename(name));
  const read = ext => (fs.existsSync(base + ext) ? fs.readFileSync(base + ext, 'utf8') : '');
  return { program: read('.ham'), terrain: read('.ter') };
}

function renderPage(sampleName) {
  const nonce = Math.random().toString(36).slice(2);
  const { program, terrain } = readSample(sampleName);
  const html = buildSimulatorHtml({
    cspSource: "'self'", nonce,
    langScriptUri: '/dist/webview/hamster-lang.js',
    simulatorScriptUri: '/dist/webview/hamster-simulator.js',
    assetsUri: '/assets', terrain, program, classSources: [],
  });
  return html
    .replace('</head>', `<style>${THEME}</style></head>`)
    .replace('<!-- Shared language', `<script nonce="${nonce}">${SHIM}</script>\n<!-- Shared language`);
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(renderPage(url.searchParams.get('sample') || 'collectRow'));
  }
  const file = path.normalize(path.join(root, url.pathname));
  const allowed = ['dist', 'assets'].some(d => file.startsWith(path.join(root, d) + path.sep));
  if (!allowed || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Simulator preview: http://localhost:${port}/?sample=collectRow`));
