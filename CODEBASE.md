# HaikuScript Complete Project Codebase

*Part of the HaikuScript docs: CODEBASE (this file, full source) · [README](README.md) (how to build & run) · [GRAMMAR](GRAMMAR.md) (how to write the language).*

This file contains the complete source code for the HaikuScript compiler frontend, syntax highlighting queries, the shared compiler core, AST parser, WebAssembly code generator, browser REPL, and native VS Code extension.

## 1. Project Configuration (`package.json`)
```json
{
  "name": "haikuscript-compiler",
  "publisher": "ghastly-bluff",
  "version": "1.0.0",
  "description": "Production-grade HaikuScript Ecosystem",
  "license": "SEE LICENSE IN LICENSE",
  "main": "./vsc-extension/extension.js",
  "engines": {
    "node": ">=20",
    "npm": ">=10",
    "vscode": "^1.85.0"
  },
  "activationEvents": [
    "onLanguage:haikuscript"
  ],
  "contributes": {
    "languages": [
      {
        "id": "haikuscript",
        "aliases": [
          "HaikuScript"
        ],
        "extensions": [
          ".hk"
        ]
      }
    ]
  },
  "scripts": {
    "tokens": "node haiku.js --dump-tokens src/fibonacci.hk",
    "ast": "node haiku.js --dump-ast src/fibonacci.hk",
    "compile": "node haiku.js --compile src/fibonacci.hk",
    "serve": "serve .",
    "repl": "serve ."
  },
  "dependencies": {
    "serve": "^14.2.1",
    "wabt": "^1.0.36"
  }
}
```

## 2. Tree-sitter Structural Rules (`grammar.js`) — *optional, editor tooling only*

> Not used to run or compile — the runtime lexer is hand-written (see §4). This grammar lets an editor parse/highlight `.hk` files, and documents the exact structure the hand lexer reproduces.
```javascript
module.exports = grammar({
  name: 'haikuscript',

  // Ignore spaces, tabs, and commas, but keep newlines strictly structural
  extras: $ => [/[ \t\r,]+/], 

  rules: {
    // A program is a repetition of stanzas OR random blank lines
    program: $ => repeat(choice($.stanza, $.newline)),

    // A stanza is exactly 3 lines, and every single line must end in a newline
    stanza: $ => seq(
      $.line, $.newline,
      $.line, $.newline,
      $.line, $.newline
    ),

    // A line is just a series of one or more words
    line: $ => repeat1($.word),

    // A word is any collection of letters or digits
    word: $ => /[a-zA-Z]+|[0-9]+/,

    newline: $ => /\n/
  }
});
```

## 3. Tree-sitter Syntax Highlight Matchers (`queries/highlights.scm`) — *optional, editor tooling only*

> Pairs with §2 for editor highlighting; not part of the runtime.
```query
; Use Tree-sitter predicates to map plain words to official editor syntax tokens
((word) @keyword
  (#match? @keyword "^(set|to|add|loop|until|equals|end)$"))

((word) @keyword.function
  (#match? @keyword.function "^(dream|imagine|random|randomly|something)$"))

((word) @number
  (#match? @number "^(zero|one|ten|[0-9]+)$"))

((word) @comment
  (#match? @comment "^(the|is|it|quietly|gently|suddenly|always|beautifully|telling|sequence)$"))

((word) @variable
  (#match? @variable "^(x|y|z|count)$"))
```

> Note: these Tree-sitter files predate the `PRINT` vocabulary and the short (1-2 char) named-identifier support added to the hand lexer in §4 — they still highlight the original fixed vocabulary correctly, but don't yet tag `print`/`say`/`announce`/etc. as keywords or arbitrary `a`, `r3`, `ww`-style names as variables. Editor highlighting only; doesn't affect compilation.

## 4. Shared Compiler Core (`haiku-core.js`)
Environment-agnostic pipeline (no `fs`, `process`, or DOM). Single source of truth for the vocabulary, syllable audit, AST parser, and code generator — consumed by both the Node CLI and the browser REPL.
```javascript
// HaikuScript shared compiler core — environment-agnostic (no fs, no process, no DOM).
// Consumed by the Node CLI (haiku.js) and the browser REPL (repl.js) so the
// vocabulary, parser, and code generator have a single source of truth.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.HaikuCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Master vocabulary database mapping keywords to syllables and token actions
  const VOCAB = {
    "loop": { syllables: 1, type: "LOOP" }, "until": { syllables: 2, type: "UNTIL" },
    "equals": { syllables: 2, type: "EQ" }, "end": { syllables: 1, type: "END" },
    "set": { syllables: 1, type: "ASSIGN" }, "to": { syllables: 1, type: "TO" },
    "add": { syllables: 1, type: "ADD" },
    "x": { syllables: 1, type: "IDENTIFIER", value: "x" },
    "y": { syllables: 1, type: "IDENTIFIER", value: "y" },
    "z": { syllables: 1, type: "IDENTIFIER", value: "z" },
    "count": { syllables: 1, type: "IDENTIFIER", value: "count" },
    "zero": { syllables: 2, type: "NUMBER", value: 0 },
    "one": { syllables: 1, type: "NUMBER", value: 1 },
    "ten": { syllables: 1, type: "NUMBER", value: 10 },
    "the": { syllables: 1, type: "IGNORE" }, "is": { syllables: 1, type: "IGNORE" },
    "it": { syllables: 1, type: "IGNORE" }, "quietly": { syllables: 3, type: "IGNORE" },
    "gently": { syllables: 2, type: "IGNORE" }, "suddenly": { syllables: 3, type: "IGNORE" },
    "always": { syllables: 2, type: "IGNORE" }, "beautifully": { syllables: 4, type: "IGNORE" },
    "telling": { syllables: 2, type: "IGNORE" }, "sequence": { syllables: 3, type: "IGNORE" },
    "dream": { syllables: 1, type: "RANDOM" }, "imagine": { syllables: 3, type: "RANDOM" },
    "random": { syllables: 2, type: "RANDOM" }, "randomly": { syllables: 3, type: "RANDOM" },
    "something": { syllables: 2, type: "RANDOM" },
    "print": { syllables: 1, type: "PRINT" }, "say": { syllables: 1, type: "PRINT" },
    "speak": { syllables: 1, type: "PRINT" }, "shout": { syllables: 1, type: "PRINT" },
    "printout": { syllables: 2, type: "PRINT" }, "announce": { syllables: 2, type: "PRINT" },
    "declare": { syllables: 2, type: "PRINT" }, "reveal": { syllables: 2, type: "PRINT" },
    "utter": { syllables: 2, type: "PRINT" }, "recite": { syllables: 2, type: "PRINT" },
    "vocalize": { syllables: 3, type: "PRINT" }, "articulate": { syllables: 4, type: "PRINT" },
    "ask": { syllables: 1, type: "INPUT" }, "guess": { syllables: 1, type: "INPUT" },
    "prompt": { syllables: 1, type: "INPUT" }, "input": { syllables: 2, type: "INPUT" },
    "user": { syllables: 2, type: "IGNORE" }
  };

  const EXPECTED_METER = [5, 7, 5];

  // BASIC-style short variable names (1-2 chars, alpha-first): syllables come from
  // how the name is SPOKEN as letters/digits (e.g. "w" = "double-u" = 3, "3" = "three" = 1).
  // Exact lookup, not a heuristic — no ambiguity like general English word syllables.
  const LETTER_SYLLABLES = {
    a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1, h: 1, i: 1, j: 1, k: 1, l: 1, m: 1,
    n: 1, o: 1, p: 1, q: 1, r: 1, s: 1, t: 1, u: 1, v: 1, w: 3, x: 1, y: 1, z: 1
  };
  // How many syllables a single digit takes when SPOKEN aloud on its own
  // ("3" -> "three" -> 1, "7" -> "seven" -> 2). Shared with getNumberSyllables'
  // units table below — same underlying fact, one source of truth.
  const DIGIT_NAME_SYLLABLES = [2, 1, 1, 1, 1, 1, 1, 2, 1, 1]; // 0-9, "zero".."nine"
  const IDENTIFIER_SHAPE = /^[a-z][a-z0-9]?$/;
  // "text{N}" — a word the lexer can't syllable-count on its own (arbitrary
  // English is ambiguous), so the author trusts an explicit count instead.
  // Packs up to 4 ASCII bytes into one i32 — reuses the NUMBER token type,
  // so parser/codegen need no changes at all; this is a lexer-only feature.
  const STRING_LITERAL_SHAPE = /^"([a-z]+)\{([0-9]+)\}"$/;
  const MAX_STRING_LITERAL_LENGTH = 4;

  function packStringLiteral(text) {
    let value = 0;
    for (const ch of text) {
      value = (value << 8) | ch.charCodeAt(0);
    }
    return value;
  }

  function getIdentifierSyllables(name) {
    let count = 0;
    for (const ch of name) {
      count += /[0-9]/.test(ch) ? DIGIT_NAME_SYLLABLES[Number(ch)] : LETTER_SYLLABLES[ch];
    }
    return count;
  }

  // A compile-time failure that carries the offending 1-based line number, so the
  // CLI can print/exit and the REPL can highlight — each caller decides how to report.
  class HaikuError extends Error {
    constructor(line, message) {
      super(message);
      this.name = 'HaikuError';
      this.line = line;
    }
  }

  function getNumberSyllables(n) {
    if (n === 0) return 2; // "zero" (2)
    
    const unitsSyllables = [
      ...DIGIT_NAME_SYLLABLES,      // 0-9 (index 0 unused — n===0 returns above, before this array exists)
      1, 3, 1, 2, 2, 2, 2, 3, 2, 2  // 10-19
    ];
    const tensSyllables = [
      0, 0, 2, 2, 2, 2, 2, 3, 2, 2  // 0-90
    ];

    let count = 0;
    let originalN = n;

    if (n >= 1000000000000000) {
      const quadrillions = Math.floor(n / 1000000000000000);
      count += getNumberSyllables(quadrillions) + 3; // "[quadrillions] quadrillion"
      n = n % 1000000000000000;
    }

    if (n >= 1000000000000) {
      const trillions = Math.floor(n / 1000000000000);
      count += getNumberSyllables(trillions) + 2; // "[trillions] trillion"
      n = n % 1000000000000;
    }

    if (n >= 1000000000) {
      const billions = Math.floor(n / 1000000000);
      count += getNumberSyllables(billions) + 2; // "[billions] billion"
      n = n % 1000000000;
    }

    if (n >= 1000000) {
      const millions = Math.floor(n / 1000000);
      count += getNumberSyllables(millions) + 2; // "[millions] million"
      n = n % 1000000;
    }

    if (n >= 1000) {
      const thousands = Math.floor(n / 1000);
      count += getNumberSyllables(thousands) + 2; // "[thousands] thousand"
      n = n % 1000;
    }

    if (n >= 100) {
      const hundreds = Math.floor(n / 100);
      count += getNumberSyllables(hundreds) + 2; // "[hundreds] hundred"
      n = n % 100;
    }

    if (n > 0) {
      if (originalN > n && originalN >= 100) {
        count += 1; // "and"
      }
      if (n < 20) {
        count += unitsSyllables[n];
      } else {
        const tens = Math.floor(n / 10);
        const units = n % 10;
        count += tensSyllables[tens] + unitsSyllables[units];
      }
    }

    return count;
  }

  // PHASE 1: Lexing + Semantic Analysis (Syllable Auditing).
  // The grammar is trivial — a line is a run of letter-words — so we tokenize by
  // hand instead of pulling in a parser. (A Tree-sitter grammar, `grammar.js`, is
  // kept alongside as an optional source of editor highlighting; it is NOT used at
  // runtime.) Each non-blank source line is one code line, checked against the
  // repeating 5/7/5 meter. Returns the token stream. Throws HaikuError.
  function tokenize(source) {
    const tokens = [];
    let lineIndex = 0;

    const lines = source.split('\n');
    for (let row = 0; row < lines.length; row++) {
      const cleanLine = lines[row].replace(/,/g, '');
      const words = cleanLine.match(/"[a-zA-Z]+\{[0-9]+\}"|[a-zA-Z]{3,}|[a-zA-Z][a-zA-Z0-9]?|[0-9]+/g);
      if (!words) continue; // blank / word-less line — not a code line

      const currentLineNum = row + 1;
      const expected = EXPECTED_METER[lineIndex % 3];
      let runningSyllables = 0;

      for (const rawWord of words) {
        const wordText = rawWord.toLowerCase();

        const stringMatch = STRING_LITERAL_SHAPE.exec(wordText);
        if (stringMatch) {
          const text = stringMatch[1];
          const syll = parseInt(stringMatch[2], 10);
          if (text.length > MAX_STRING_LITERAL_LENGTH) {
            throw new HaikuError(currentLineNum, `String literal "${text}" is too long — max ${MAX_STRING_LITERAL_LENGTH} characters (packs into one i32).`);
          }
          runningSyllables += syll;
          tokens.push({ type: "NUMBER", value: packStringLiteral(text), line: currentLineNum });
          continue;
        }

        if (/^[0-9]+$/.test(wordText)) {
          const val = parseInt(wordText, 10);
          if (val > Number.MAX_SAFE_INTEGER) {
            throw new HaikuError(currentLineNum, `Number "${wordText}" exceeds the maximum safe integer (${Number.MAX_SAFE_INTEGER}).`);
          }
          runningSyllables += getNumberSyllables(val);
          tokens.push({
            type: "NUMBER",
            value: val,
            line: currentLineNum
          });
          continue;
        }

        if (!VOCAB[wordText]) {
          if (IDENTIFIER_SHAPE.test(wordText)) {
            const syll = getIdentifierSyllables(wordText);
            runningSyllables += syll;
            tokens.push({ type: "IDENTIFIER", value: wordText, line: currentLineNum });
            continue;
          }
          throw new HaikuError(currentLineNum, `Forbidden word "${wordText}" is outside the allowable vocabulary dictionary.`);
        }

        runningSyllables += VOCAB[wordText].syllables;

        if (VOCAB[wordText].type !== "IGNORE") {
          tokens.push({
            type: VOCAB[wordText].type,
            value: VOCAB[wordText].value !== undefined ? VOCAB[wordText].value : wordText,
            line: currentLineNum
          });
        }
      }

      if (runningSyllables !== expected) {
        throw new HaikuError(currentLineNum, `Poetic meter broken. Expected ${expected} syllables, but calculated ${runningSyllables}.`);
      }
      lineIndex++;
    }

    return tokens;
  }

  // PHASE 2: Recursive AST Parser
  function parseProgram(tokens) {
    let current = 0;

    function parseAST() {
      if (current >= tokens.length) return null;
      const token = tokens[current];

      if (token.type === "ASSIGN") {
        current++; const target = tokens[current++];
        if (tokens[current] && tokens[current].type === "TO") current++;
        const value = tokens[current++];
        // "set x to <random>" — treat a RANDOM word in value position as a roll.
        if (value && value.type === "RANDOM") {
          return { type: "RandomStatement", target: target.value };
        }
        // "set x to <input>" — treat an INPUT word in value position as a read.
        if (value && value.type === "INPUT") {
          return { type: "InputStatement", target: target.value };
        }
        return { type: "AssignmentStatement", target: target.value, value: value.value };
      }
      if (token.type === "ADD") {
        current++; const source = tokens[current++];
        if (tokens[current] && tokens[current].type === "TO") current++;
        const target = tokens[current++];
        return { type: "AdditionStatement", source: source.value, target: target.value };
      }
      if (token.type === "RANDOM") {
        current++;
        if (tokens[current] && tokens[current].type === "TO") current++;
        const target = tokens[current++];
        return { type: "RandomStatement", target: target.value };
      }
      if (token.type === "PRINT") {
        current++;
        if (tokens[current] && tokens[current].type === "TO") current++;
        const value = tokens[current++];
        return { type: "PrintStatement", value: value.value };
      }
      if (token.type === "INPUT") {
        current++;
        if (tokens[current] && tokens[current].type === "TO") current++;
        const target = tokens[current++];
        return { type: "InputStatement", target: target.value };
      }
      if (token.type === "LOOP") {
        current++; if (tokens[current] && tokens[current].type === "UNTIL") current++;
        const left = tokens[current++]; if (tokens[current] && tokens[current].type === "EQ") current++;
        const right = tokens[current++];
        const node = { type: "WhileLoopStatement", condition: { left: left.value, right: right.value }, body: [] };

        while (current < tokens.length && tokens[current].type !== "END") {
          const stmt = parseAST();
          if (stmt) node.body.push(stmt);
        }
        current++; // Skip END
        if (current < tokens.length && tokens[current].type === "LOOP") current++; // Skip trailing LOOP
        return node;
      }
      current++;
      return null;
    }

    const ast = { type: "Program", body: [] };
    while (current < tokens.length) {
      const stmt = parseAST();
      if (stmt) ast.body.push(stmt);
    }
    return ast;
  }

  // Named vars aren't limited to x/y/z/count anymore, so locals can't be hardcoded —
  // walk the AST once and collect every distinct name actually referenced.
  function collectIdentifiers(node, names) {
    if (!node) return;
    if (node.type === "AssignmentStatement") {
      names.add(node.target);
      if (typeof node.value === 'string') names.add(node.value);
    } else if (node.type === "AdditionStatement") {
      names.add(node.target);
      if (typeof node.source === 'string') names.add(node.source);
    } else if (node.type === "RandomStatement") {
      names.add(node.target);
    } else if (node.type === "PrintStatement") {
      if (typeof node.value === 'string') names.add(node.value);
    } else if (node.type === "InputStatement") {
      names.add(node.target);
    } else if (node.type === "WhileLoopStatement") {
      // Either side of the condition can be a variable or a number literal —
      // every existing example only ever compared a var to a fixed number, so
      // this was never exercised, but "loop until g equals s" (two variables)
      // is exactly what a real program (e.g. a guess-vs-secret check) needs.
      if (typeof node.condition.left === 'string') names.add(node.condition.left);
      if (typeof node.condition.right === 'string') names.add(node.condition.right);
      node.body.forEach(child => collectIdentifiers(child, names));
    }
  }

  // PHASE 3: Code Generation — turn the AST into a WebAssembly Text (.wat) module.
  function generateWat(ast, seed) {
    // The compiler bakes a 32-bit seed (nonzero) into the module's own PRNG.
    // Callers pass a fresh seed per compile (e.g. Date.now()) so each build
    // produces a different sequence; the emitted WASM itself needs no host.
    const RNG_SEED = ((seed >>> 0) || 0x9E3779B9);
    let indent = "  ";
    let watBody = "";

    function walk(node) {
      if (!node) return "";
      if (node.type === "AssignmentStatement") {
        let v = typeof node.value === 'number' ? `i32.const ${node.value}` : `local.get $${node.value}`;
        return `${indent}${v}\n${indent}local.set $${node.target}\n`;
      }
      if (node.type === "AdditionStatement") {
        let s = typeof node.source === 'number' ? `i32.const ${node.source}` : `local.get $${node.source}`;
        return `${indent}local.get $${node.target}\n${indent}${s}\n${indent}i32.add\n${indent}local.set $${node.target}\n`;
      }
      if (node.type === "RandomStatement") {
        // Advance the compiler's own PRNG (emitted below) — no host involvement.
        return `${indent}call $next_random\n${indent}local.set $${node.target}\n`;
      }
      if (node.type === "PrintStatement") {
        // Unlike everything else, this crosses out of the module — needs the host's $print import.
        let v = typeof node.value === 'number' ? `i32.const ${node.value}` : `local.get $${node.value}`;
        return `${indent}${v}\n${indent}call $print\n`;
      }
      if (node.type === "InputStatement") {
        // Mirror image of PrintStatement — pulls a value in from the host's $input import.
        return `${indent}call $input\n${indent}local.set $${node.target}\n`;
      }
      if (node.type === "WhileLoopStatement") {
        let out = `${indent}block\n${indent}loop\n`;
        indent += "  ";
        let l = typeof node.condition.left === 'number' ? `i32.const ${node.condition.left}` : `local.get $${node.condition.left}`;
        let r = typeof node.condition.right === 'number' ? `i32.const ${node.condition.right}` : `local.get $${node.condition.right}`;
        out += `${indent}${l}\n${indent}${r}\n${indent}i32.eq\n${indent}br_if 1\n`;
        node.body.forEach(c => { out += walk(c); });
        out += `${indent}br 0\n`;
        indent = indent.substring(0, indent.length - 2);
        return out + `${indent}end\n${indent}end\n`;
      }
      return "";
    }

    ast.body.forEach(n => { watBody += walk(n); });

    const localNames = new Set(['x']); // compute() always returns x
    ast.body.forEach(n => collectIdentifiers(n, localNames));
    const localsDecl = Array.from(localNames).map(n => `(local $${n} i32)`).join(' ');

    // Self-contained xorshift32 PRNG emitted by the compiler — no imports.
    // $next_random advances a mutable global and returns a value in [0, 100).
    const prng =
      `  (global $rng (mut i32) (i32.const ${RNG_SEED}))\n` +
      `  (func $next_random (result i32) (local $s i32)\n` +
      `    global.get $rng local.set $s\n` +
      `    local.get $s local.get $s i32.const 13 i32.shl i32.xor local.set $s\n` +
      `    local.get $s local.get $s i32.const 17 i32.shr_u i32.xor local.set $s\n` +
      `    local.get $s local.get $s i32.const 5 i32.shl i32.xor local.set $s\n` +
      `    local.get $s global.set $rng\n` +
      `    local.get $s i32.const 100 i32.rem_u)\n`;
    return `(module\n  (import "env" "print" (func $print (param i32)))\n  (import "env" "input" (func $input (result i32)))\n${prng}  (func $compute (result i32)\n    ${localsDecl}\n\n${watBody}\n    local.get $x\n  )\n  (export "compute" (func $compute))\n)`;
  }

  return { VOCAB, EXPECTED_METER, HaikuError, tokenize, parseProgram, generateWat };
});
```

## 5. Compiler Pipeline CLI (`haiku.js`)
Node entry point. Owns file I/O and CLI flags (`--dump-tokens`, `--dump-ast`, `--compile`, `--run`, `--json-errors`); delegates all lexing and compilation to the shared core. `--run` assembles the WAT to WASM and executes it immediately, supplying `console.log` as the `env.print` host import so `PrintStatement`s surface mid-run, and a blocking stdin reader as the `env.input` import so `InputStatement`s can read a value back. `--compile` writes its `.wat`/`.wasm` output to `build/` — kept separate from the `.hk` sources under `src/` regardless of the input file's own location.
```javascript
const fs = require('fs');
const path = require('path');
const { tokenize, parseProgram, generateWat, HaikuError } = require('./haiku-core');

// WASM imports are called synchronously, so reading input has to block —
// stdin read via fs.readSync rather than readline's async interface.
// A single OS read can return several lines at once (common with piped
// input), so leftover bytes are kept across calls and consumed one line
// at a time instead of being silently discarded.
let stdinLeftover = '';
function readInputSync() {
  process.stdout.write('Input: ');
  while (!stdinLeftover.includes('\n')) {
    const buf = Buffer.alloc(1024);
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(0, buf, 0, 1024, null);
    } catch (err) {
      break; // stdin closed/unavailable
    }
    if (bytesRead === 0) break; // EOF
    stdinLeftover += buf.toString('utf8', 0, bytesRead);
  }
  const newlineIndex = stdinLeftover.indexOf('\n');
  let line;
  if (newlineIndex === -1) {
    line = stdinLeftover;
    stdinLeftover = '';
  } else {
    line = stdinLeftover.slice(0, newlineIndex);
    stdinLeftover = stdinLeftover.slice(newlineIndex + 1);
  }
  const value = parseInt(line.trim(), 10);
  return Number.isNaN(value) ? 0 : value;
}

// Helper to handle standard logging vs structured JSON errors for the IDE extension
function emitError(jsonMode, line, message) {
  if (jsonMode) {
    console.log(JSON.stringify({ line: line - 1, message }));
  } else {
    console.error(`\x1b[31mError [Line ${line}]: ${message}\x1b[0m`);
  }
  process.exit(1);
}

async function runCompiler() {
  // Initialize WebAssembly Binary Toolkit (WABT) for inline machine assembly
  const wabt = await require('wabt')();

  const args = process.argv.slice(2);
  const flag = args[0];
  const jsonMode = flag === '--json-errors';
  const targetFile = args[1];

  if (!targetFile) {
    console.error("Missing input haiku target file.");
    process.exit(1);
  }

  const sourceCode = fs.readFileSync(targetFile, 'utf8');

  // PHASE 1: Lex + Syllable Audit — shared core, CLI-style reporting
  let tokens;
  try {
    tokens = tokenize(sourceCode);
  } catch (err) {
    if (err instanceof HaikuError) emitError(jsonMode, err.line, err.message);
    throw err;
  }

  // Handle diagnostic dumps
  if (flag === '--dump-tokens') {
    console.log(JSON.stringify(tokens, null, 2));
    process.exit(0);
  }

  // PHASE 2: Recursive AST Parser
  const ast = parseProgram(tokens);

  if (flag === '--dump-ast') {
    console.log(JSON.stringify(ast, null, 2));
    process.exit(0);
  }

  // PHASE 3: Code Generation, Assembly, and (for --run) Execution
  if (flag === '--run') {
    const fullWat = generateWat(ast, Date.now());
    const wasmModule = wabt.parseWat(targetFile, fullWat);
    const { buffer } = wasmModule.toBinary({});
    const importObject = { env: { print: (v) => console.log('Print:', v), input: readInputSync } };
    const { instance } = await WebAssembly.instantiate(buffer, importObject);
    console.log('Result:', instance.exports.compute());
    process.exit(0);
  }

  if (flag === '--compile') {
    const fullWat = generateWat(ast, Date.now());

    // Build output is kept separate from source — never alongside the .hk file.
    const buildDir = 'build';
    fs.mkdirSync(buildDir, { recursive: true });
    const baseName = path.basename(targetFile, '.hk');
    const watPath = path.join(buildDir, `${baseName}.wat`);
    const wasmPath = path.join(buildDir, `${baseName}.wasm`);

    // Write out the human-readable WebAssembly Text Blueprint
    fs.writeFileSync(watPath, fullWat);
    console.log(`\x1b[32mSuccessfully compiled to WebAssembly Text (${watPath})!\x1b[0m`);

    // Compile directly into native browser-executable WASM binary bytes using WABT
    try {
      const wasmModule = wabt.parseWat(targetFile, fullWat);
      const { buffer } = wasmModule.toBinary({});
      fs.writeFileSync(wasmPath, Buffer.from(buffer));
      console.log(`\x1b[32mSuccessfully assembled to WebAssembly Binary (${wasmPath})!\x1b[0m`);
    } catch (wasmErr) {
      console.error(`\x1b[31mAssembly Error: ${wasmErr.message}\x1b[0m`);
    }
  }
}

runCompiler();
```

## 6. Browser REPL Driver (`repl.js`)
Runs the whole pipeline client-side: the shared core lexes/audits/parses/generates from the editor text, WABT assembles WASM in-browser, and `WebAssembly.instantiate` executes it — supplying the same `env.print` import as the CLI (collecting values into the **Printed Output** panel), plus `env.input` backed by `window.prompt` (synchronous, same reason it works — WASM imports must return immediately). Also wires up file open/save.
```javascript
// HaikuScript browser REPL — runs the full compiler pipeline client-side.
// Globals provided by the <script> tags in repl.html:
//   HaikuCore    (haiku-core.js)
//   WabtModule   (wabt/index.js)
(function () {
  'use strict';

  const DEFAULT_SOURCE = [
    'Set x to zero',
    'Set y to one quietly',
    'Set count to zero',
    '',
    'Loop until the count',
    'equals ten beautifully',
    'Set z to the x',
    '',
    'Add y to the z',
    'Set x to y suddenly',
    'Set y to the z',
    '',
    'Add one to the count',
    'Gently end the loop always',
    'Quietly it is'
  ].join('\n');

  const $ = (id) => document.getElementById(id);
  const editor = $('editor');
  const status = $('status');
  const fileName = $('fileName');

  let wabt = null;     // WABT instance (lazily initialised, reused across runs)
  let fileHandle = null; // File System Access API handle, when available

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = 'status' + (kind ? ' ' + kind : '');
  }

  // Lazily boot the WABT assembler exactly once.
  async function ensureToolchain() {
    if (wabt) return;
    setStatus('Booting WABT…', 'busy');
    wabt = await WabtModule();
  }

  function highlightLine(line) {
    if (!line) return;
    const lines = editor.value.split('\n');
    let start = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) start += lines[i].length + 1;
    const end = start + (lines[line - 1] ? lines[line - 1].length : 0);
    editor.focus();
    editor.setSelectionRange(start, end);
  }

  // Full pipeline: parse -> audit/tokenize -> AST -> WAT -> WASM -> execute.
  async function run() {
    $('result').className = 'result';
    $('result').textContent = 'Running…';
    $('tokens').textContent = '';
    $('ast').textContent = '';
    $('wat').textContent = '';
    $('printed').textContent = '';

    try {
      await ensureToolchain();
      const source = editor.value;

      setStatus('Phase 1 — lexing & syllable audit…', 'busy');
      const tokens = HaikuCore.tokenize(source);
      $('tokens').textContent = JSON.stringify(tokens, null, 2);

      setStatus('Phase 2 — building AST…', 'busy');
      const ast = HaikuCore.parseProgram(tokens);
      $('ast').textContent = JSON.stringify(ast, null, 2);

      setStatus('Phase 3 — generating WAT & assembling WASM…', 'busy');
      const wat = HaikuCore.generateWat(ast, Date.now());
      $('wat').textContent = wat;

      const module = wabt.parseWat('repl.wat', wat);
      const { buffer } = module.toBinary({});
      const printed = [];
      const readInput = () => {
        const value = parseInt(window.prompt('Input:') || '', 10);
        return Number.isNaN(value) ? 0 : value;
      };
      const importObject = { env: { print: (v) => printed.push(v), input: readInput } };
      const { instance } = await WebAssembly.instantiate(buffer, importObject);

      const value = instance.exports.compute();
      $('printed').textContent = printed.length ? printed.join('\n') : '(none)';
      $('result').textContent = 'Result: ' + value;
      $('result').className = 'result ok';
      setStatus('Done ✓', 'ok');
    } catch (err) {
      const line = err && err.line;
      $('result').textContent = (line ? 'Error [Line ' + line + ']: ' : 'Error: ') + err.message;
      $('result').className = 'result err';
      setStatus('Failed ✗', 'err');
      highlightLine(line);
    }
  }

  // ---- File open / save --------------------------------------------------
  const canFsAccess = 'showOpenFilePicker' in window;

  async function openFile() {
    try {
      if (canFsAccess) {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: 'HaikuScript', accept: { 'text/plain': ['.hk'] } }]
        });
        fileHandle = handle;
        const file = await handle.getFile();
        editor.value = await file.text();
        fileName.textContent = file.name;
        setStatus('Opened ' + file.name, 'ok');
      } else {
        $('filePicker').click();
      }
    } catch (err) {
      if (err.name !== 'AbortError') setStatus('Open failed: ' + err.message, 'err');
    }
  }

  function openViaInput(evt) {
    const file = evt.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      editor.value = reader.result;
      fileName.textContent = file.name;
      setStatus('Opened ' + file.name, 'ok');
    };
    reader.readAsText(file);
  }

  function downloadFallback(name, text) {
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function saveFile(forceDialog) {
    const text = editor.value;
    try {
      if (canFsAccess && (fileHandle || forceDialog) && 'showSaveFilePicker' in window) {
        if (forceDialog || !fileHandle) {
          fileHandle = await window.showSaveFilePicker({
            suggestedName: fileName.textContent || 'poem.hk',
            types: [{ description: 'HaikuScript', accept: { 'text/plain': ['.hk'] } }]
          });
        }
        const writable = await fileHandle.createWritable();
        await writable.write(text);
        await writable.close();
        const file = await fileHandle.getFile();
        fileName.textContent = file.name;
        setStatus('Saved ' + file.name, 'ok');
      } else {
        downloadFallback(fileName.textContent || 'poem.hk', text);
        setStatus('Downloaded ' + (fileName.textContent || 'poem.hk'), 'ok');
      }
    } catch (err) {
      if (err.name !== 'AbortError') setStatus('Save failed: ' + err.message, 'err');
    }
  }

  // ---- Wiring ------------------------------------------------------------
  function init() {
    editor.value = DEFAULT_SOURCE;
    // Try to load the on-disk sample so the REPL mirrors the CLI's fibonacci.hk.
    fetch('/src/fibonacci.hk').then(r => r.ok ? r.text() : null).then(t => {
      if (t) { editor.value = t; fileName.textContent = 'fibonacci.hk'; }
    }).catch(() => {});

    $('runBtn').addEventListener('click', run);
    $('openBtn').addEventListener('click', openFile);
    $('saveBtn').addEventListener('click', () => saveFile(false));
    $('saveAsBtn').addEventListener('click', () => saveFile(true));
    $('filePicker').addEventListener('change', openViaInput);

    editor.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(false); }
    });

    if (!canFsAccess) {
      $('saveAsBtn').textContent = 'Download';
      $('saveBtn').style.display = 'none';
    }
    setStatus('Ready — press Run (or Ctrl+Enter)');
  }

  window.addEventListener('DOMContentLoaded', init);
})();
```

## 7. Browser REPL Page (`repl.html`)
Served at `/repl.html`. Loads the shared core and the `wabt` assembler straight out of `node_modules`, then the REPL driver. The **Printed Output** panel shows every value a `PrintStatement` surfaced mid-run, in order, above the final **Result**.
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HaikuScript REPL</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      font-family: system-ui, sans-serif;
      margin: 0;
      padding: 1.5rem;
      max-width: 1100px;
      margin-inline: auto;
    }
    h1 { margin: 0 0 .25rem; font-size: 1.4rem; }
    p.sub { margin: 0 0 1rem; opacity: .7; font-size: .9rem; }
    .toolbar { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-bottom: .75rem; }
    button {
      font: inherit; padding: .45rem .9rem; border: 1px solid #8888; border-radius: 6px;
      background: #f4f4f4; cursor: pointer;
    }
    button:hover { background: #e8e8e8; }
    #runBtn { background: #0b7; border-color: #0b7; color: #fff; font-weight: 600; }
    #runBtn:hover { background: #0a6; }
    #fileName { margin-left: auto; font-size: .85rem; opacity: .8; font-family: ui-monospace, monospace; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
    textarea {
      width: 100%; height: 340px; font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: .95rem; line-height: 1.5; padding: .75rem; border: 1px solid #8886; border-radius: 8px;
      resize: vertical; background: #fff; color: #111;
    }
    @media (prefers-color-scheme: dark) { textarea { background: #1b1b1b; color: #eee; } }
    .status { margin: .6rem 0; font-size: .85rem; min-height: 1.2em; }
    .status.busy { color: #b70; } .status.ok { color: #087a2f; } .status.err { color: #c40000; }
    .result {
      font-size: 1.6rem; font-weight: bold; padding: .8rem 1rem; border-radius: 8px;
      background: #f2f2f2; color: #333; margin-bottom: 1rem;
    }
    .result.ok { background: #e6ffed; color: #087a2f; }
    .result.err { background: #ffecec; color: #c40000; font-size: 1rem; }
    details { border: 1px solid #8886; border-radius: 8px; margin-bottom: .6rem; }
    summary { cursor: pointer; padding: .5rem .75rem; font-weight: 600; }
    pre {
      margin: 0; padding: .75rem; overflow-x: auto; font-size: .82rem;
      border-top: 1px solid #8884; background: #00000008;
    }
  </style>
</head>
<body>
  <h1>HaikuScript REPL</h1>
  <p class="sub">Edit the poem, then Run — parse → syllable audit → AST → WAT → WASM → execute, all in your browser.</p>

  <div class="toolbar">
    <button id="runBtn" title="Ctrl+Enter">▶ Run</button>
    <button id="openBtn">Open…</button>
    <button id="saveBtn" title="Ctrl+S">Save</button>
    <button id="saveAsBtn">Save As…</button>
    <span id="fileName">untitled.hk</span>
    <input id="filePicker" type="file" accept=".hk,text/plain" hidden>
  </div>

  <div class="grid">
    <div>
      <textarea id="editor" spellcheck="false"></textarea>
      <div id="status" class="status"></div>
    </div>
    <div>
      <div id="result" class="result">—</div>
      <details open>
        <summary>Printed Output</summary>
        <pre id="printed"></pre>
      </details>
      <details open>
        <summary>Tokens</summary>
        <pre id="tokens"></pre>
      </details>
      <details>
        <summary>AST</summary>
        <pre id="ast"></pre>
      </details>
      <details>
        <summary>WebAssembly Text (.wat)</summary>
        <pre id="wat"></pre>
      </details>
    </div>
  </div>

  <!-- Shared compiler core, then the WABT assembler, then the REPL driver -->
  <script src="/haiku-core.js"></script>
  <script src="/node_modules/wabt/index.js"></script>
  <script src="/repl.js"></script>
</body>
</html>
```

## 8. VS Code IDE Extension Connector (`vsc-extension/extension.js`)
```javascript
const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');

function activate(context) {
  console.log("👉 [HaikuScript IDE Bridge]: Extension Waking Up Now!");
  
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('haikuscript');
  context.subscriptions.push(diagnosticCollection);

  function validateDocument(document) {
    if (document.languageId !== 'haikuscript') return;

    const compilerPath = path.join(context.extensionPath, 'haiku.js');
    const command = `node "${compilerPath}" --json-errors "${document.fileName}"`;

    // Force the execution to run directly inside your project folder
    exec(command, { cwd: context.extensionPath }, (error, stdout, stderr) => {
      diagnosticCollection.clear();    
      
      // ADD THESE TWO DIAGNOSTIC LINES HERE:
      console.log("HaikuScript Compiler STDOUT:", stdout);
      console.log("HaikuScript Compiler ERROR:", error);

      if (error && stdout) {
        try {
          const errData = JSON.parse(stdout.trim());
          const line = document.lineAt(errData.line);
          const range = new vscode.Range(errData.line, 0, errData.line, line.text.length);
          const diagnostic = new vscode.Diagnostic(range, errData.message, vscode.DiagnosticSeverity.Error);
          
          diagnosticCollection.set(document.uri, [diagnostic]);
        } catch (e) {
          // Parsing fallback
        }
      } else if (stderr) {
        console.error("Compiler background crash:", stderr);
      }
    });
  }

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(validateDocument));
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(validateDocument));
}

function deactivate() {}

module.exports = { activate, deactivate };
```

## 9. Web Sandbox Test Harness (`index.html`)
A minimal single-shot page that fetches the pre-compiled `build/fibonacci.wasm` (built by `npm run compile`, which writes its `.wat`/`.wasm` output to `build/` — separate from the `.hk` sources under `src/`) and renders the result on screen (and to the console).
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>HaikuScript Engine</title>
  <style>
    body { font-family: system-ui, sans-serif; text-align: center; padding: 3rem; }
    #result {
      display: inline-block;
      margin-top: 1.5rem;
      padding: 1rem 2rem;
      font-size: 2rem;
      font-weight: bold;
      border-radius: 8px;
      background: #f2f2f2;
      color: #333;
    }
    #result.ok { background: #e6ffed; color: #087a2f; }
    #result.err { background: #ffecec; color: #c40000; font-size: 1rem; }
  </style>
</head>
<body>
  <h1>HaikuScript WebAssembly Sandbox</h1>
  <p>Your compiled poetry runs below (and logs to the browser console).</p>
  <div id="result">Running…</div>

  <script>
    async function loadPoemExecution() {
      const output = document.getElementById('result');
      try {
        const serverResponse = await fetch('build/fibonacci.wasm');
        const compiledInstance = await WebAssembly.instantiate(await serverResponse.arrayBuffer());
        const calculationResult = compiledInstance.instance.exports.compute();

        output.textContent = 'Result: ' + calculationResult;
        output.className = 'ok';
        console.log("%c[HaikuScript Result Processed]: " + calculationResult, "color:#00ff00; font-weight:bold; font-size:16px;");
      } catch (err) {
        output.textContent = 'WASM Runtime Error: ' + err.message;
        output.className = 'err';
        console.error("WASM Runtime Error:", err);
      }
    }
    loadPoemExecution();
  </script>
</body>
</html>
```

## 10. Source Poetry Input Code (`src/fibonacci.hk`)
All sample poems now live under `src/` — `fibonacci.hk` (below), plus `test_digits.hk` (digit-literal variant of the same program), `named_vars.hk` and `syllable_check.hk` (exercise the short named-identifier feature in §4), `ten_randoms.hk` (loop + `PrintStatement` demo, printing ten random draws instead of only the final `x`), `input_demo.hk` (exercises all four `INPUT` keywords — `guess`, `ask user`, `prompt`, and `set ... to input` — reading four values back with `PrintStatement`), `string_literal_demo.hk` (packs `"cat{1}"` into a number via the `"text{N}"` string-literal syntax in §4, prints it alongside a guess read via `INPUT`), and `hangman.hk` (a minimal guess-the-word game combining all of the above — `loop until g equals s` keeps reading guesses until one matches the packed secret word, then prints the winning guess and how many tries it took).
```text
Set x to zero
Set y to one quietly
Set count to zero

Loop until the count
equals ten beautifully
Set z to the x

Add y to the z
Set x to y suddenly
Set y to the z

Add one to the count
Gently end the loop always
Quietly it is
```
