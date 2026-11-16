import type { HamsterLanguageError } from './hamster-parser.js';

export function collectSemanticErrors(
    ast: Record<string, unknown>,
    options?: { resolvesAllNames?: boolean }
): HamsterLanguageError[];

export function collectDiagnostics(
    source: string,
    options?: Record<string, unknown>
): HamsterLanguageError[];
