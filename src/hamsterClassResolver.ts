import * as vscode from 'vscode';
import { detectProgramType, ProgramType } from '../lang/hamster-parser.js';

const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'out']);

/** Finds class-program sources below the entry file's directory. */
export async function resolveHamsterClassSources(programUri: vscode.Uri): Promise<string[]> {
    const rootUri = vscode.Uri.joinPath(programUri, '..');
    const pendingDirectories = [rootUri];
    const classSources: Array<{ path: string; source: string }> = [];
    const decoder = new TextDecoder('utf-8');

    while (pendingDirectories.length > 0) {
        const directoryUri = pendingDirectories.pop()!;
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(directoryUri);
        } catch {
            continue;
        }

        entries.sort(([left], [right]) => left.localeCompare(right));
        for (const [name, type] of entries) {
            const entryUri = vscode.Uri.joinPath(directoryUri, name);
            if ((type & vscode.FileType.Directory) !== 0) {
                if ((type & vscode.FileType.SymbolicLink) === 0 &&
                    !EXCLUDED_DIRECTORIES.has(name.toLowerCase())) {
                    pendingDirectories.push(entryUri);
                }
                continue;
            }
            if ((type & vscode.FileType.File) === 0 ||
                !name.toLowerCase().endsWith('.ham') ||
                entryUri.toString() === programUri.toString()) {
                continue;
            }

            try {
                const source = decoder.decode(await vscode.workspace.fs.readFile(entryUri));
                if (detectProgramType(source) === ProgramType.Class) {
                    classSources.push({ path: entryUri.toString(), source });
                }
            } catch {
                // A concurrently removed or unreadable source is not a class module.
            }
        }
    }

    return classSources
        .sort((left, right) => left.path.localeCompare(right.path))
        .map(entry => entry.source);
}