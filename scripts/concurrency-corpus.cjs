#!/usr/bin/env node
/**
 * Measures how much of the reference corpus the cooperative-threads feature can
 * reach (SC-001 of specs/003-cooperative-threads).
 *
 * Unlike `conformance.cjs` this is a *classification* pass, not a parse pass:
 * every concurrency-using program is sorted into one of four buckets so the
 * ones blocked by out-of-scope library classes are reported by category rather
 * than counted as concurrency failures.
 *
 * Usage:
 *   node scripts/concurrency-corpus.cjs [referenceDir] [--verbose]
 *   HAMSTER_REFERENCE_DIR=... node scripts/concurrency-corpus.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_REFERENCE_DIR =
    'D:\\Projects\\hamstersimulator-v29-06-eclipse\\hamstersimulator-v29-06-eclipse\\hamstersimulator-2.9.6';
const CORPUS_SUBDIRECTORY = 'Programme';

const EXIT_CORPUS_MISSING = 2;
const EXIT_BELOW_TARGET = 3;

/** Programs needing nothing beyond threads and monitors — this feature's target. */
const TARGET_REACHABLE = 95;

const CONCURRENCY = /\.start\s*\(\s*\)|extends\s+Thread\b|\bsynchronized\b|implements\s+Runnable\b/;
const CONCURRENCY_UTILITIES = /^\s*import\s+java\.util\.concurrent|^\s*import\s+java\.util\.Timer/m;
const COLLECTION_CLASSES = /\b(ArrayList|HashMap|Vector|LinkedList|Iterator|HashSet|TreeMap)\b/;
const ALLROUND_HAMSTER = /^\s*import\s+util\.AllroundHamster/m;

function parseArguments(argv) {
    const options = { referenceDir: null, verbose: false };
    for (const arg of argv) {
        if (arg === '--verbose') options.verbose = true;
        else if (!arg.startsWith('--') && !options.referenceDir) options.referenceDir = arg;
    }
    options.referenceDir =
        options.referenceDir || process.env.HAMSTER_REFERENCE_DIR || DEFAULT_REFERENCE_DIR;
    return options;
}

function findHamFiles(directory) {
    const found = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name))) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) found.push(...findHamFiles(full));
        else if (entry.name.toLowerCase().endsWith('.ham')) found.push(full);
    }
    return found;
}

/**
 * `synchronized` inside a comment is not concurrency. Strip comments and string
 * literals before classifying, so a program is only counted when it really uses
 * a thread construct.
 */
function stripCommentsAndStrings(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

function classify(source) {
    const code = stripCommentsAndStrings(source);
    if (!CONCURRENCY.test(code)) return null;
    if (CONCURRENCY_UTILITIES.test(source)) return 'concurrencyUtilities';
    if (COLLECTION_CLASSES.test(code)) return 'collections';
    if (ALLROUND_HAMSTER.test(source)) return 'allroundHamster';
    return 'reachable';
}

function main() {
    const options = parseArguments(process.argv.slice(2));
    const corpusDir = path.join(options.referenceDir, CORPUS_SUBDIRECTORY);

    if (!fs.existsSync(corpusDir)) {
        console.error('Reference corpus not found at ' + corpusDir);
        console.error('Pass the reference directory as an argument or set HAMSTER_REFERENCE_DIR.');
        process.exitCode = EXIT_CORPUS_MISSING;
        return;
    }

    const buckets = {
        reachable: [], allroundHamster: [], concurrencyUtilities: [], collections: [],
    };
    let total = 0;

    for (const file of findHamFiles(corpusDir)) {
        total++;
        // The corpus is latin1, like conformance.cjs reads it.
        const bucket = classify(fs.readFileSync(file, 'latin1'));
        if (bucket) buckets[bucket].push(path.relative(corpusDir, file));
    }

    const concurrencyTotal = Object.values(buckets).reduce((sum, list) => sum + list.length, 0);

    console.log('Concurrency corpus classification');
    console.log('  reference dir : ' + options.referenceDir);
    console.log('  .ham files    : ' + total);
    console.log('  using threads : ' + concurrencyTotal);
    console.log('');
    const rows = [
        ['reachable (threads + monitors only)', buckets.reachable.length, 'TARGET'],
        ['needs util.AllroundHamster (import gap)', buckets.allroundHamster.length, 'out of scope here'],
        ['needs java.util.concurrent / Timer', buckets.concurrencyUtilities.length, 'out of scope'],
        ['needs collection classes', buckets.collections.length, 'out of scope'],
    ];
    for (const [label, count, note] of rows) {
        console.log('  ' + label.padEnd(42) + String(count).padStart(4) + '   ' + note);
    }

    if (options.verbose) {
        for (const [name, list] of Object.entries(buckets)) {
            console.log('\n' + name + ':');
            for (const file of list) console.log('  ' + file);
        }
    }

    console.log('');
    if (buckets.reachable.length < TARGET_REACHABLE) {
        console.error('Reachable count ' + buckets.reachable.length +
            ' is below the SC-001 target of ' + TARGET_REACHABLE);
        process.exitCode = EXIT_BELOW_TARGET;
        return;
    }
    console.log('SC-001 target met: ' + buckets.reachable.length + ' >= ' + TARGET_REACHABLE);
}

main();
