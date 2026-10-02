import * as vscode from 'vscode';

/**
 * Resolves the `.ter` terrain file content associated with a `.ham` program file.
 *
 * Resolution policy (deterministic, same for normal runs and debug launches):
 * 1. Prefer the `.ter` file that shares the program's exact basename (e.g. `foo.ham` → `foo.ter`).
 * 2. Otherwise, if the program's folder contains exactly one `.ter` file, use that file.
 *    This avoids depending on directory-listing order when multiple candidates exist.
 * 3. Otherwise, no terrain is associated with the program (returns `undefined`), and callers
 *    should reset the simulator to its default terrain rather than keep a stale one.
 */
export async function resolveTerrain(hamUri: vscode.Uri): Promise<string | undefined> {
    const dirUri = vscode.Uri.joinPath(hamUri, '..');
    const uriPath = hamUri.path;
    const lastSlash = uriPath.lastIndexOf('/');
    const fileName = uriPath.substring(lastSlash + 1);
    const baseName = fileName.endsWith('.ham') ? fileName.slice(0, -4) : fileName;
    const exactTerUri = vscode.Uri.joinPath(dirUri, baseName + '.ter');
    const decoder = new TextDecoder('utf-8');

    try {
        const data = await vscode.workspace.fs.readFile(exactTerUri);
        return decoder.decode(data);
    } catch { /* no exact match, fall through to the unambiguous folder fallback */ }

    try {
        const entries = await vscode.workspace.fs.readDirectory(dirUri);
        const terEntries = entries.filter(([name]) => name.endsWith('.ter'));
        if (terEntries.length === 1) {
            const data = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dirUri, terEntries[0][0]));
            return decoder.decode(data);
        }
    } catch { /* directory listing failed, e.g. folder doesn't exist */ }

    return undefined;
}
