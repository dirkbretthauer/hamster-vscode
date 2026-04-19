# Changelog

## 0.2.0 — Web Extension Support

- Migrated to VS Code web extension — now runs in vscode.dev and github.dev
- Replaced Node.js `fs`/`path` APIs with `vscode.workspace.fs` and `vscode.Uri`
- Added webpack bundling for `webworker` target
- Fully compatible with desktop VS Code as well

## 0.1.0 — Initial Release

- Syntax highlighting for `.ham` files (Java-like Hamster language)
- Simulator panel with Run, Step, Stop, and Reset controls
- Canvas-based terrain rendering with hamster, walls, and corn
- Step debugging with editor line highlighting
- Custom terrain editor for `.ter` files with wall, corn, and hamster placement tools
- Real-time parse error diagnostics
