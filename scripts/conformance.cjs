'use strict';
/**
 * Parses every sample `.ham` program shipped with the Java reference Hamster
 * Simulator (`<reference>/Programme`) and reports how many the extension's
 * parser accepts, grouped by failure message. Not part of `npm test` because
 * the corpus lives outside this repo.
 *
 * Usage:
 *   npm run conformance -- [referenceDir] [--verbose] [--min-pass-rate=0.9]
 *
 * `referenceDir` defaults to $HAMSTER_REFERENCE_DIR, then the location
 * documented in AGENTS.md. `--min-pass-rate` makes the script exit non-zero
 * when the parse rate drops below the given fraction (a regression guard).
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DEFAULT_REFERENCE_DIR =
    'D:\\Projects\\hamstersimulator-v29-06-eclipse\\hamstersimulator-v29-06-eclipse\\hamstersimulator-2.9.6';
const CORPUS_SUBDIRECTORY = 'Programme';
const EXAMPLES_PER_FAILURE = 3;
const EXIT_CORPUS_MISSING = 2;
const EXIT_BELOW_MIN_PASS_RATE = 3;

// The reference editor's Scratch/FSM/flowchart programs are XML documents, not Java-like source.
const VISUAL_PROGRAM_PREFIX = '<';

function parseArguments(argv) {
    const options = { referenceDir: null, verbose: false, minPassRate: null };
    for (const argument of argv) {
        if (argument === '--verbose') {
            options.verbose = true;
        } else if (argument.startsWith('--min-pass-rate=')) {
            options.minPassRate = Number(argument.slice('--min-pass-rate='.length));
            if (!(options.minPassRate >= 0 && options.minPassRate <= 1)) {
                throw new Error('--min-pass-rate must be a fraction between 0 and 1');
            }
        } else if (argument.startsWith('--')) {
            throw new Error('Unknown option: ' + argument);
        } else {
            options.referenceDir = argument;
        }
    }
    options.referenceDir ??= process.env.HAMSTER_REFERENCE_DIR || DEFAULT_REFERENCE_DIR;
    return options;
}

function findHamFiles(directory, files = []) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            findHamFiles(entryPath, files);
        } else if (entry.name.toLowerCase().endsWith('.ham')) {
            files.push(entryPath);
        }
    }
    return files.sort();
}

/** Strips locations so identical failures in different files group together. */
function normalizeFailureMessage(message) {
    return String(message)
        .replace(/\s*\(line \d+, column \d+\)/, '')
        .replace(/^Line \d+, column \d+: /, '');
}

function errorLine(error) {
    return error?.token?.line ?? error?.line ?? null;
}

function classifyProgram(parser, source) {
    if (source.trimStart().startsWith(VISUAL_PROGRAM_PREFIX)) {
        return { evaluated: false, label: 'visual (XML)' };
    }
    const programType = parser.detectProgramType(source) ?? 'unknown marker';
    const evaluatedTypes = new Set([
        parser.ProgramType.Imperative,
        parser.ProgramType.ObjectOriented,
        parser.ProgramType.Class,
        'unknown marker',
    ]);
    return { evaluated: evaluatedTypes.has(programType), label: programType };
}

function formatPercent(passed, total) {
    return total === 0 ? 'n/a' : (100 * passed / total).toFixed(1) + '%';
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    const corpusDir = path.join(options.referenceDir, CORPUS_SUBDIRECTORY);
    if (!fs.existsSync(corpusDir)) {
        console.error(`Reference corpus not found: ${corpusDir}`);
        console.error('Pass the reference directory as an argument or set HAMSTER_REFERENCE_DIR.');
        process.exitCode = EXIT_CORPUS_MISSING;
        return;
    }

    const parserPath = path.resolve(__dirname, '..', 'lang', 'hamster-parser.js');
    const parser = await import(pathToFileURL(parserPath).href);

    const countsByType = new Map();
    const skippedByType = new Map();
    const failuresByMessage = new Map();
    for (const file of findHamFiles(corpusDir)) {
        // The reference simulator reads sources with the platform charset, which is Latin-1 compatible for these files.
        const source = fs.readFileSync(file, 'latin1');
        const relativePath = path.relative(corpusDir, file);
        const { evaluated, label } = classifyProgram(parser, source);
        if (!evaluated) {
            skippedByType.set(label, (skippedByType.get(label) || 0) + 1);
            continue;
        }
        const counts = countsByType.get(label) || { passed: 0, failed: 0 };
        countsByType.set(label, counts);
        try {
            parser.parseProgram(source, { strict: true });
            counts.passed += 1;
        } catch (error) {
            counts.failed += 1;
            const message = normalizeFailureMessage(error?.message ?? error);
            const failures = failuresByMessage.get(message) || [];
            failures.push({ relativePath, line: errorLine(error), source });
            failuresByMessage.set(message, failures);
        }
    }

    let totalPassed = 0;
    let totalEvaluated = 0;
    console.log(`Hamster reference corpus: ${corpusDir}\n`);
    console.log('Program type        Passed  Failed  Rate');
    for (const [label, { passed, failed }] of countsByType) {
        totalPassed += passed;
        totalEvaluated += passed + failed;
        console.log(
            label.padEnd(18),
            String(passed).padStart(7),
            String(failed).padStart(7),
            ' ' + formatPercent(passed, passed + failed)
        );
    }
    console.log(
        'TOTAL'.padEnd(18),
        String(totalPassed).padStart(7),
        String(totalEvaluated - totalPassed).padStart(7),
        ' ' + formatPercent(totalPassed, totalEvaluated)
    );
    const skipped = [...skippedByType].map(([label, count]) => `${label}: ${count}`).join(', ');
    if (skipped) {
        console.log(`\nSkipped (not Java-like): ${skipped}`);
    }

    const sortedFailures = [...failuresByMessage].sort((left, right) => right[1].length - left[1].length);
    if (sortedFailures.length > 0) {
        console.log('\nFailures by message:');
    }
    for (const [message, failures] of sortedFailures) {
        console.log(`\n${String(failures.length).padStart(4)}  ${message}`);
        const shown = options.verbose ? failures : failures.slice(0, EXAMPLES_PER_FAILURE);
        for (const { relativePath, line, source } of shown) {
            const sourceLine = line ? (source.split(/\r?\n/)[line - 1] || '').trim() : '';
            console.log(`      ${relativePath}${line ? ':' + line : ''}`);
            if (sourceLine) console.log(`        | ${sourceLine.slice(0, 120)}`);
        }
    }

    const passRate = totalEvaluated === 0 ? 0 : totalPassed / totalEvaluated;
    if (options.minPassRate !== null && passRate < options.minPassRate) {
        console.error(
            `\nParse rate ${formatPercent(totalPassed, totalEvaluated)} is below ` +
            `--min-pass-rate=${options.minPassRate}`
        );
        process.exitCode = EXIT_BELOW_MIN_PASS_RATE;
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
