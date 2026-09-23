export interface HamsterLanguageError extends Error {
    token?: {
        line: number;
        column: number;
        length?: number;
    };
    line?: number;
    column?: number;
    length?: number;
}

export function collectProgramErrors(
    source: string,
    options?: Record<string, unknown>
): HamsterLanguageError[];

export function parseProgram(
    source: string,
    options?: Record<string, unknown>
): Record<string, unknown>;

export function collectExecutableLines(ast: Record<string, unknown>): number[];

export function findExecutableLineAtOrAfter(
    requestedLine: number,
    executableLines: number[]
): number | null;
