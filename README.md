# Hamster Simulator – VS Code Extension

A VS Code extension for writing and running [Hamster Simulator](https://www.java-hamster-modell.de/) programs (`.ham` files) with an integrated visual simulator.

## Features

- **Syntax highlighting** for `.ham` files (Java-like Hamster language)
- **Simulator panel** with Run, Step, Stop, and Reset controls
- **Terrain editor** for `.ter` files with wall, corn, and hamster placement tools
- **Real-time diagnostics** showing parse errors as you type
- **Step debugging** with line highlighting in the editor

## Usage

1. Open a `.ham` file
2. Click the ▶ icon in the editor title bar (or run **Hamster: Open Simulator** from the command palette)
3. Click **Run** to execute the program or **Step** to step through it

Terrain files (`.ter`) placed alongside `.ham` files are loaded automatically. Open a `.ter` file directly to edit the terrain visually.

## Commands

| Command | Description |
|---|---|
| `Hamster: Open Simulator` | Open the simulator panel |
| `Hamster: Run Program` | Run the current program |
| `Hamster: Step` | Execute one step |
| `Hamster: Stop` | Stop execution |
| `Hamster: Reset` | Reset to initial terrain |

## Development

```bash
npm install
npm run compile
# Press F5 in VS Code to launch Extension Development Host
```

To build a `.vsix` package:

```bash
npm run package
```
