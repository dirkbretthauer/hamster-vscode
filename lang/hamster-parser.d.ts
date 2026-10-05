export interface HamsterLanguageError extends Error {
    token?: {
        line: number;
        column: number;
        length?: number;
    };
    line?: number;
    column?: number;
    length?: number;
    /** Set only for recognised-but-unsupported Java syntax (a known gap). */
    unsupportedConstruct?: string | null;
}

export const UnsupportedConstruct: Readonly<Record<string, string>>;

export const ProgramType: Readonly<Record<string, string>>;

export function detectProgramType(source: string): string;

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
