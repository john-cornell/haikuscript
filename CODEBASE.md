# HaikuScript Complete Project Codebase

*Part of the HaikuScript docs: CODEBASE (this file, full source) · [README](README.md) (how to build & run) · [GRAMMAR](GRAMMAR.md) (how to write the language).*

This file contains the complete source code for the HaikuScript compiler frontend, syntax highlighting queries, the shared compiler core, AST parser, WebAssembly and CIL code generators, browser REPL and its static/`ilasm.exe` build server, and native VS Code extension.

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
    "serve": "node server.js",
    "repl": "node server.js"
  },
  "dependencies": {
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
Environment-agnostic pipeline (no `fs`, `process`, or DOM). Single source of truth for the vocabulary, syllable audit, AST parser, and code generators — consumed by both the Node CLI and the browser REPL. The core now ships two backends walking the exact same AST: `generateWat` (WebAssembly Text, assembled to real WASM and executed) and `generateIl` (an ildasm-style CIL disassembly listing that is genuinely buildable — it emits a full assembly manifest, a `HaikuHost` class, and a `Main` entry point, so the REPL's **Build .exe** button can hand it straight to `ilasm.exe` and get back a working `HaikuProgram.exe`). Both take the same `seed` argument so their emitted PRNG literals are directly comparable — the "one AST, multiple backends" point of the talk.
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
  // Grouped by token type, alphabetical within each group.
  const VOCAB = {
    "add": { syllables: 1, type: "ADD" },

    "and": { syllables: 1, type: "AND" },

    "assign": { syllables: 2, type: "ASSIGN" }, "remember": { syllables: 3, type: "ASSIGN" },
    "set": { syllables: 1, type: "ASSIGN" },

    "else": { syllables: 2, type: "ELSE" },

    "end": { syllables: 1, type: "END" },

    "equals": { syllables: 2, type: "EQ" },

    "above": { syllables: 2, type: "GT" }, "more": { syllables: 1, type: "GT" },
    "over": { syllables: 2, type: "GT" },

    "count": { syllables: 1, type: "IDENTIFIER", value: "count" },
    "x": { syllables: 1, type: "IDENTIFIER", value: "x" },
    "y": { syllables: 1, type: "IDENTIFIER", value: "y" },
    "z": { syllables: 1, type: "IDENTIFIER", value: "z" },

    "if": { syllables: 1, type: "IF" },

    "always": { syllables: 2, type: "IGNORE" }, "beautifully": { syllables: 4, type: "IGNORE" },
    "done": { syllables: 1, type: "IGNORE" }, "gently": { syllables: 2, type: "IGNORE" },
    "is": { syllables: 1, type: "IGNORE" }, "it": { syllables: 1, type: "IGNORE" },
    "now": { syllables: 1, type: "IGNORE" }, "out": { syllables: 1, type: "IGNORE" },
    "please": { syllables: 1, type: "IGNORE" }, "quietly": { syllables: 3, type: "IGNORE" },
    "sequence": { syllables: 3, type: "IGNORE" }, "should": { syllables: 1, type: "IGNORE" },
    "suddenly": { syllables: 3, type: "IGNORE" }, "telling": { syllables: 2, type: "IGNORE" },
    "than": { syllables: 1, type: "IGNORE" }, "the": { syllables: 1, type: "IGNORE" },
    "user": { syllables: 2, type: "IGNORE" }, "you": { syllables: 1, type: "IGNORE" },

    "ask": { syllables: 1, type: "INPUT" }, "guess": { syllables: 1, type: "INPUT" },
    "input": { syllables: 2, type: "INPUT" }, "prompt": { syllables: 1, type: "INPUT" },

    "loop": { syllables: 1, type: "LOOP" },

    "below": { syllables: 2, type: "LT" }, "less": { syllables: 1, type: "LT" },
    "under": { syllables: 2, type: "LT" },

    "not": { syllables: 1, type: "NOT" },

    "one": { syllables: 1, type: "NUMBER", value: 1 },
    "ten": { syllables: 1, type: "NUMBER", value: 10 },
    "zero": { syllables: 2, type: "NUMBER", value: 0 },

    "or": { syllables: 1, type: "OR" },

    "announce": { syllables: 2, type: "PRINT" }, "articulate": { syllables: 4, type: "PRINT" },
    "declare": { syllables: 2, type: "PRINT" }, "print": { syllables: 1, type: "PRINT" },
    "printout": { syllables: 2, type: "PRINT" }, "recite": { syllables: 2, type: "PRINT" },
    "reveal": { syllables: 2, type: "PRINT" }, "say": { syllables: 1, type: "PRINT" },
    "shout": { syllables: 1, type: "PRINT" }, "speak": { syllables: 1, type: "PRINT" },
    "utter": { syllables: 2, type: "PRINT" }, "vocalize": { syllables: 3, type: "PRINT" },

    "dream": { syllables: 1, type: "RANDOM" }, "imagine": { syllables: 3, type: "RANDOM" },
    "random": { syllables: 2, type: "RANDOM" }, "randomly": { syllables: 3, type: "RANDOM" },
    "something": { syllables: 2, type: "RANDOM" },

    "to": { syllables: 1, type: "TO" },

    "until": { syllables: 2, type: "UNTIL" },

    "while": { syllables: 1, type: "WHILE" },

    "xor": { syllables: 1, type: "XOR" }
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
    let lastLineNum = 0;

    const lines = source.split('\n');
    for (let row = 0; row < lines.length; row++) {
      const cleanLine = lines[row].replace(/,/g, '');
      const words = cleanLine.match(/[a-zA-Z]{3,}|[a-zA-Z][a-zA-Z0-9]?|[0-9]+/g);
      if (!words) continue; // blank / word-less line — not a code line

      const currentLineNum = row + 1;
      lastLineNum = currentLineNum;
      const expected = EXPECTED_METER[lineIndex % 3];
      let runningSyllables = 0;

      for (const rawWord of words) {
        const wordText = rawWord.toLowerCase();

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

    // A stanza is three lines; a poem that ends mid-stanza still tokenizes
    // fine line-by-line (each line only answers to its own position in the
    // repeating meter), so this is the one check that looks at the *shape*
    // of the whole poem rather than one line at a time.
    if (lineIndex % 3 !== 0) {
      const linesShort = 3 - (lineIndex % 3);
      throw new HaikuError(lastLineNum, `Incomplete stanza — the poem ends ${linesShort} line${linesShort === 1 ? '' : 's'} short of a full 3-line stanza.`);
    }

    return tokens;
  }

  // PHASE 2: Recursive AST Parser
  function parseProgram(tokens) {
    let current = 0;
    const REL_TYPES = { EQ: 'eq', LT: 'lt', GT: 'gt' };
    const JOIN_TYPES = { AND: 'and', OR: 'or', XOR: 'xor' };

    // A condition is a flat chain of comparisons joined by and/or/xor, evaluated
    // strictly left to right — no precedence, no parentheses. Keeps the parser a
    // simple loop instead of needing real precedence-climbing machinery. "not"
    // only ever negates the single comparison right after it, e.g.
    // "not g equals s" is != , "not g over s" is <=, "not g under s" is >=.
    function parseConditionTerm() {
      let negate = false;
      if (tokens[current] && tokens[current].type === "NOT") { negate = true; current++; }
      const left = tokens[current++];
      const op = REL_TYPES[tokens[current++].type];
      const right = tokens[current++];
      return { negate, left: left.value, op, right: right.value };
    }

    function parseCondition() {
      const terms = [parseConditionTerm()];
      while (tokens[current] && JOIN_TYPES[tokens[current].type]) {
        const join = JOIN_TYPES[tokens[current].type];
        current++;
        const term = parseConditionTerm();
        term.join = join;
        terms.push(term);
      }
      return terms;
    }

    function parseAST() {
      if (current >= tokens.length) return null;
      const token = tokens[current];

      if (token.type === "ASSIGN") {
        // "set x to zero" reads target-first; "assign ten to x" reads
        // value-first — that's the natural English word order for each verb,
        // not an arbitrary choice, so which word was used (token.value) picks
        // the argument order rather than both synonyms sharing one grammar.
        const usesValueFirst = token.value === "assign";
        current++;
        let target, value;
        if (usesValueFirst) {
          value = tokens[current++];
          if (tokens[current] && tokens[current].type === "TO") current++;
          target = tokens[current++];
        } else {
          target = tokens[current++];
          if (tokens[current] && tokens[current].type === "TO") current++;
          value = tokens[current++];
        }
        // "set/assign ... <random>" — treat a RANDOM word in value position as a roll.
        if (value && value.type === "RANDOM") {
          return { type: "RandomStatement", target: target.value };
        }
        // "set/assign ... <input>" — treat an INPUT word in value position as a read.
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
      if (token.type === "LOOP" || token.type === "UNTIL" || token.type === "WHILE") {
        // "until" implies a loop on its own — "loop" is just the explicit form.
        // "while" also starts a loop, but with OPPOSITE polarity: "until X"
        // continues while X is false, exiting the instant it's true; "while X"
        // continues while X is true, exiting the instant it's false — the
        // natural English meaning of each word, not an arbitrary choice (same
        // reasoning as assign/set/remember's differing argument order). The
        // invert flag lets codegen negate the WHOLE combined condition once,
        // after and/or/xor are folded together — never per-term, since De
        // Morgan's laws mean negating one term of a multi-term chain doesn't
        // negate the chain's result.
        const invert = token.type === "WHILE";
        current++; if (tokens[current] && tokens[current].type === "UNTIL") current++;
        const terms = parseCondition();
        const node = { type: "WhileLoopStatement", condition: { terms, invert }, body: [] };

        while (current < tokens.length && tokens[current].type !== "END") {
          const stmt = parseAST();
          if (stmt) node.body.push(stmt);
        }
        current++; // Skip END
        if (current < tokens.length && tokens[current].type === "LOOP") current++; // Skip trailing LOOP
        return node;
      }
      if (token.type === "IF") {
        current++;
        const terms = parseCondition();
        const node = { type: "IfStatement", condition: { terms }, thenBody: [], elseBody: [] };

        while (current < tokens.length && tokens[current].type !== "END" && tokens[current].type !== "ELSE") {
          const stmt = parseAST();
          if (stmt) node.thenBody.push(stmt);
        }
        if (current < tokens.length && tokens[current].type === "ELSE") {
          current++; // Skip ELSE
          while (current < tokens.length && tokens[current].type !== "END") {
            const stmt = parseAST();
            if (stmt) node.elseBody.push(stmt);
          }
        }
        current++; // Skip END
        if (current < tokens.length && tokens[current].type === "IF") current++; // Skip trailing IF
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
      // Either side of any comparison term can be a variable or a number literal.
      node.condition.terms.forEach(term => {
        if (typeof term.left === 'string') names.add(term.left);
        if (typeof term.right === 'string') names.add(term.right);
      });
      node.body.forEach(child => collectIdentifiers(child, names));
    } else if (node.type === "IfStatement") {
      node.condition.terms.forEach(term => {
        if (typeof term.left === 'string') names.add(term.left);
        if (typeof term.right === 'string') names.add(term.right);
      });
      node.thenBody.forEach(child => collectIdentifiers(child, names));
      node.elseBody.forEach(child => collectIdentifiers(child, names));
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

    // Emits a flat chain of comparisons (and/or/xor, left to right, no
    // precedence) leaving a single 0/1 i32 on the stack. WASM's bitwise
    // and/or/xor work directly as logical ops here since operands are
    // always exactly 0 or 1; i32.eqz gives NOT the same way.
    const REL_INSTR = { eq: 'i32.eq', lt: 'i32.lt_s', gt: 'i32.gt_s' };
    const JOIN_INSTR = { and: 'i32.and', or: 'i32.or', xor: 'i32.xor' };
    function emitCondition(terms) {
      let out = '';
      terms.forEach((term, i) => {
        const l = typeof term.left === 'number' ? `i32.const ${term.left}` : `local.get $${term.left}`;
        const r = typeof term.right === 'number' ? `i32.const ${term.right}` : `local.get $${term.right}`;
        out += `${indent}${l}\n${indent}${r}\n${indent}${REL_INSTR[term.op]}\n`;
        if (term.negate) out += `${indent}i32.eqz\n`;
        if (i > 0) out += `${indent}${JOIN_INSTR[term.join]}\n`;
      });
      return out;
    }

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
        out += emitCondition(node.condition.terms);
        // "while" negates the whole combined condition once, here — after
        // and/or/xor are folded, never per-term (see the parser's LOOP branch).
        if (node.condition.invert) out += `${indent}i32.eqz\n`;
        out += `${indent}br_if 1\n`;
        node.body.forEach(c => { out += walk(c); });
        out += `${indent}br 0\n`;
        indent = indent.substring(0, indent.length - 2);
        return out + `${indent}end\n${indent}end\n`;
      }
      if (node.type === "IfStatement") {
        // WASM's structured if/else/end pops the top-of-stack 0/1 directly —
        // emitCondition already leaves exactly that, so this is a near-literal
        // translation, unlike WhileLoopStatement's block/loop/br_if dance.
        let out = emitCondition(node.condition.terms);
        out += `${indent}if\n`;
        indent += "  ";
        node.thenBody.forEach(c => { out += walk(c); });
        indent = indent.substring(0, indent.length - 2);
        if (node.elseBody.length) {
          out += `${indent}else\n`;
          indent += "  ";
          node.elseBody.forEach(c => { out += walk(c); });
          indent = indent.substring(0, indent.length - 2);
        }
        out += `${indent}end\n`;
        return out;
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

  // PHASE 3b: Code Generation — turn the AST into an ildasm-style CIL
  // listing that ilasm can actually assemble into a working .exe (see the
  // REPL's Build .exe button). Walks the exact same AST as generateWat via
  // a parallel walk()/emitCondition() pair, so the two backends are easy to
  // compare instruction-by-instruction. See
  // docs/superpowers/specs/2026-08-11-repl-syntax-compile-exe-design.md.
  function generateIl(ast, seed) {
    const RNG_SEED = ((seed >>> 0) || 0x9E3779B9);
    const RNG_SEED_SIGNED = RNG_SEED > 0x7FFFFFFF ? RNG_SEED - 0x100000000 : RNG_SEED;

    const localNames = new Set(['x']); // Compute() always returns x
    ast.body.forEach(n => collectIdentifiers(n, localNames));
    const localList = Array.from(localNames);
    const localIndex = new Map(localList.map((name, i) => [name, i]));

    let nextLabel = 0;
    function newLabel() { return `L${nextLabel++}`; }

    function ldc(instrs, value) {
      if (value === -1) instrs.push({ op: 'ldc.i4.m1' });
      else if (value >= 0 && value <= 8) instrs.push({ op: `ldc.i4.${value}` });
      else if (value >= -128 && value <= 127) instrs.push({ op: 'ldc.i4.s', arg: value });
      else instrs.push({ op: 'ldc.i4', arg: value });
    }
    function ldlocSlot(instrs, slot, comment) {
      if (slot <= 3) instrs.push({ op: `ldloc.${slot}`, comment });
      else instrs.push({ op: 'ldloc.s', arg: slot, comment });
    }
    function stlocSlot(instrs, slot, comment) {
      if (slot <= 3) instrs.push({ op: `stloc.${slot}`, comment });
      else instrs.push({ op: 'stloc.s', arg: slot, comment });
    }
    function ldloc(instrs, name) { ldlocSlot(instrs, localIndex.get(name), name); }
    function stloc(instrs, name) { stlocSlot(instrs, localIndex.get(name), name); }
    function pushOperand(instrs, operand) {
      if (typeof operand === 'number') ldc(instrs, operand);
      else ldloc(instrs, operand);
    }

    const REL_OP = { eq: 'ceq', lt: 'clt', gt: 'cgt' };
    const JOIN_OP = { and: 'and', or: 'or', xor: 'xor' };

    // Mirrors generateWat's emitCondition: flat and/or/xor chain, left to
    // right, no precedence — leaves a single 0/1 on the stack.
    function emitCondition(instrs, terms) {
      terms.forEach((term, i) => {
        pushOperand(instrs, term.left);
        pushOperand(instrs, term.right);
        instrs.push({ op: REL_OP[term.op] });
        if (term.negate) { ldc(instrs, 0); instrs.push({ op: 'ceq' }); }
        if (i > 0) instrs.push({ op: JOIN_OP[term.join] });
      });
    }

    function walk(instrs, node) {
      if (!node) return;
      if (node.type === 'AssignmentStatement') {
        pushOperand(instrs, node.value);
        stloc(instrs, node.target);
        return;
      }
      if (node.type === 'AdditionStatement') {
        ldloc(instrs, node.target);
        pushOperand(instrs, node.source);
        instrs.push({ op: 'add' });
        stloc(instrs, node.target);
        return;
      }
      if (node.type === 'RandomStatement') {
        instrs.push({ op: 'call', arg: 'int32 HaikuProgram::NextRandom()' });
        stloc(instrs, node.target);
        return;
      }
      if (node.type === 'PrintStatement') {
        pushOperand(instrs, node.value);
        instrs.push({ op: 'call', arg: 'void HaikuHost::Print(int32)' });
        return;
      }
      if (node.type === 'InputStatement') {
        instrs.push({ op: 'call', arg: 'int32 HaikuHost::Input()' });
        stloc(instrs, node.target);
        return;
      }
      if (node.type === 'WhileLoopStatement') {
        const start = newLabel();
        const end = newLabel();
        instrs.push({ label: start });
        emitCondition(instrs, node.condition.terms);
        if (node.condition.invert) { ldc(instrs, 0); instrs.push({ op: 'ceq' }); }
        instrs.push({ op: 'brtrue.s', arg: end });
        node.body.forEach(c => walk(instrs, c));
        instrs.push({ op: 'br.s', arg: start });
        instrs.push({ label: end });
        return;
      }
      if (node.type === 'IfStatement') {
        const hasElse = node.elseBody.length > 0;
        const elseLabel = hasElse ? newLabel() : null;
        const endLabel = newLabel();
        emitCondition(instrs, node.condition.terms);
        instrs.push({ op: 'brfalse.s', arg: hasElse ? elseLabel : endLabel });
        node.thenBody.forEach(c => walk(instrs, c));
        if (hasElse) {
          instrs.push({ op: 'br.s', arg: endLabel });
          instrs.push({ label: elseLabel });
          node.elseBody.forEach(c => walk(instrs, c));
        }
        instrs.push({ label: endLabel });
        return;
      }
    }

    const bodyInstrs = [];
    ast.body.forEach(n => walk(bodyInstrs, n));
    ldloc(bodyInstrs, 'x');
    bodyInstrs.push({ op: 'ret' });

    // ---- Byte-size + address resolution ----------------------------------
    const OPCODE_SIZE = {
      'ldc.i4.m1': 1, 'ldc.i4.0': 1, 'ldc.i4.1': 1, 'ldc.i4.2': 1, 'ldc.i4.3': 1,
      'ldc.i4.4': 1, 'ldc.i4.5': 1, 'ldc.i4.6': 1, 'ldc.i4.7': 1, 'ldc.i4.8': 1,
      'ldc.i4.s': 2, 'ldc.i4': 5,
      'ldloc.0': 1, 'ldloc.1': 1, 'ldloc.2': 1, 'ldloc.3': 1, 'ldloc.s': 2,
      'stloc.0': 1, 'stloc.1': 1, 'stloc.2': 1, 'stloc.3': 1, 'stloc.s': 2,
      'ldarg.0': 1,
      add: 1, ceq: 2, clt: 2, cgt: 2, and: 1, or: 1, xor: 1, ret: 1,
      shl: 1, 'shr.un': 1, 'rem.un': 1,
      'brfalse.s': 2, 'brtrue.s': 2, 'br.s': 2,
      call: 5, ldsfld: 5, stsfld: 5
    };

    function resolveAddresses(instrs) {
      const labelAddr = new Map();
      let addr = 0;
      instrs.forEach(instr => {
        if (instr.label !== undefined) { labelAddr.set(instr.label, addr); return; }
        const size = OPCODE_SIZE[instr.op];
        if (size === undefined) throw new Error(`generateIl: no OPCODE_SIZE entry for '${instr.op}'`);
        instr.addr = addr;
        addr += size;
      });
      return labelAddr;
    }

    function hex4(n) { return 'IL_' + n.toString(16).padStart(4, '0'); }

    const BRANCH_OPS = new Set(['br.s', 'brfalse.s', 'brtrue.s']);
    function renderInstrs(instrs, labelAddr, indent) {
      let out = '';
      instrs.forEach(instr => {
        if (instr.label !== undefined) return;
        let line = `${indent}${hex4(instr.addr)}: ${instr.op.padEnd(10)}`;
        if (BRANCH_OPS.has(instr.op)) line += ` ${hex4(labelAddr.get(instr.arg))}`;
        else if (instr.arg !== undefined) line += ` ${instr.arg}`;
        if (instr.comment) line += ` // ${instr.comment}`;
        out += line + '\n';
      });
      return out;
    }

    const bodyLabelAddr = resolveAddresses(bodyInstrs);
    const bodyText = renderInstrs(bodyInstrs, bodyLabelAddr, '    ');
    const localsDecl = localList.map((name, i) => `        [${i}] int32 ${name}`).join(',\n');

    // ---- NextRandom() — same xorshift32 algorithm as generateWat's
    // $next_random, translated instruction-for-instruction into CIL. --------
    const rngInstrs = [];
    rngInstrs.push({ op: 'ldsfld', arg: 'int32 HaikuProgram::rng' });
    stlocSlot(rngInstrs, 0, 's');
    ldlocSlot(rngInstrs, 0, 's'); ldlocSlot(rngInstrs, 0, 's'); ldc(rngInstrs, 13);
    rngInstrs.push({ op: 'shl' }); rngInstrs.push({ op: 'xor' }); stlocSlot(rngInstrs, 0, 's');
    ldlocSlot(rngInstrs, 0, 's'); ldlocSlot(rngInstrs, 0, 's'); ldc(rngInstrs, 17);
    rngInstrs.push({ op: 'shr.un' }); rngInstrs.push({ op: 'xor' }); stlocSlot(rngInstrs, 0, 's');
    ldlocSlot(rngInstrs, 0, 's'); ldlocSlot(rngInstrs, 0, 's'); ldc(rngInstrs, 5);
    rngInstrs.push({ op: 'shl' }); rngInstrs.push({ op: 'xor' }); stlocSlot(rngInstrs, 0, 's');
    ldlocSlot(rngInstrs, 0, 's'); rngInstrs.push({ op: 'stsfld', arg: 'int32 HaikuProgram::rng' });
    ldlocSlot(rngInstrs, 0, 's'); ldc(rngInstrs, 100); rngInstrs.push({ op: 'rem.un' });
    rngInstrs.push({ op: 'ret' });

    const cctorInstrs = [];
    ldc(cctorInstrs, RNG_SEED_SIGNED);
    // Same 32 bits as the WAT $rng global, just decoded as CIL's signed int32
    // instead of WASM's i32.const — attach the hex form so the two backends'
    // seed literals are directly comparable side by side despite the
    // different-looking decimal representations.
    cctorInstrs[cctorInstrs.length - 1].comment =
      '0x' + RNG_SEED.toString(16).toUpperCase() + ' — same 32 bits as the WAT $rng global';
    cctorInstrs.push({ op: 'stsfld', arg: 'int32 HaikuProgram::rng' });
    cctorInstrs.push({ op: 'ret' });

    const rngLabelAddr = resolveAddresses(rngInstrs);
    const rngText = renderInstrs(rngInstrs, rngLabelAddr, '    ');
    const cctorLabelAddr = resolveAddresses(cctorInstrs);
    const cctorText = renderInstrs(cctorInstrs, cctorLabelAddr, '    ');

    // ---- HaikuHost.Print/Input — real Console-backed implementations, plus
    // HaikuProgram.Main as the assembly's entry point. Unlike Compute()'s
    // body, these are small and fixed regardless of the AST, so they're
    // written directly as instruction lists instead of via walk(). ----------
    const printInstrs = [
      { op: 'ldarg.0' },
      { op: 'call', arg: 'void [mscorlib]System.Console::WriteLine(int32)' },
      { op: 'ret' }
    ];
    const inputInstrs = [
      { op: 'call', arg: 'string [mscorlib]System.Console::ReadLine()' },
      { op: 'stloc.0' },
      { op: 'ldloc.0' },
      { op: 'call', arg: 'int32 [mscorlib]System.Int32::Parse(string)' },
      { op: 'ret' }
    ];
    const mainInstrs = [
      { op: 'call', arg: 'int32 HaikuProgram::Compute()' },
      { op: 'call', arg: 'void [mscorlib]System.Console::WriteLine(int32)' },
      { op: 'ret' }
    ];
    const printLabelAddr = resolveAddresses(printInstrs);
    const printText = renderInstrs(printInstrs, printLabelAddr, '    ');
    const inputLabelAddr = resolveAddresses(inputInstrs);
    const inputText = renderInstrs(inputInstrs, inputLabelAddr, '    ');
    const mainLabelAddr = resolveAddresses(mainInstrs);
    const mainText = renderInstrs(mainInstrs, mainLabelAddr, '    ');

    return (
      '// ildasm-style disassembly emitted directly by HaikuScript — buildable\n' +
      '// with `ilasm <file> /exe` (Windows .NET Framework or Mono\'s ilasm).\n' +
      '.assembly extern mscorlib {}\n' +
      '.assembly HaikuProgram\n' +
      '{\n' +
      '  .ver 1:0:0:0\n' +
      '}\n' +
      '.module HaikuProgram.exe\n\n' +
      '.class private auto ansi HaikuHost\n' +
      '       extends [mscorlib]System.Object\n' +
      '{\n' +
      '  .method public hidebysig static void Print(int32 v) cil managed\n' +
      '  {\n' +
      '    .maxstack 8\n\n' +
      printText +
      '  } // end of method HaikuHost::Print\n\n' +
      '  .method public hidebysig static int32 Input() cil managed\n' +
      '  {\n' +
      '    .maxstack 8\n' +
      '    .locals init ([0] string s)\n\n' +
      inputText +
      '  } // end of method HaikuHost::Input\n' +
      '} // end of class HaikuHost\n\n' +
      '.class private auto ansi HaikuProgram\n' +
      '       extends [mscorlib]System.Object\n' +
      '{\n' +
      '  .field private static int32 rng\n\n' +
      '  .method private hidebysig static int32 NextRandom() cil managed\n' +
      '  {\n' +
      '    .maxstack 8\n' +
      '    .locals init ([0] int32 s)\n\n' +
      rngText +
      '  } // end of method HaikuProgram::NextRandom\n\n' +
      '  .method public hidebysig static int32 Compute() cil managed\n' +
      '  {\n' +
      '    .maxstack 8\n' +
      '    .locals init (\n' + localsDecl + '\n    )\n\n' +
      bodyText +
      '  } // end of method HaikuProgram::Compute\n\n' +
      '  .method private hidebysig static void .cctor() cil managed\n' +
      '  {\n' +
      '    .maxstack 8\n\n' +
      cctorText +
      '  } // end of method HaikuProgram::.cctor\n\n' +
      '  .method public hidebysig static void Main() cil managed\n' +
      '  {\n' +
      '    .entrypoint\n' +
      '    .maxstack 8\n\n' +
      mainText +
      '  } // end of method HaikuProgram::Main\n' +
      '} // end of class HaikuProgram\n'
    );
  }

  return { VOCAB, EXPECTED_METER, HaikuError, tokenize, parseProgram, generateWat, generateIl };
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
Runs the whole pipeline client-side. `compilePipeline()` is the shared prefix of Run and Compile: the shared core lexes/audits/parses/generates WAT *and* IL from the editor text, then WABT assembles the WAT to WASM in-browser — populating the Tokens/AST/WAT/IL panels and enabling the **Build .exe** button, but never executing anything. `run()` calls `compilePipeline()` and then `WebAssembly.instantiate`s the result, supplying the same `env.print` import as the CLI (collecting values into the **Printed Output** panel) plus `env.input` backed by `window.prompt` (synchronous, same reason it works — WASM imports must return immediately). `compileOnly()` calls `compilePipeline()` and stops there — no `input()` prompts fire, but Printed Output is still cleared by the shared `resetPanels()`, same as Run. `buildExe()` POSTs the displayed IL text to the server's `/build-exe` route (`server.js`, which shells out to `ilasm.exe`) and downloads the resulting `HaikuProgram.exe`; the button disables itself for the duration of the request as a re-entrancy guard. `switchTab()` toggles between the **REPL** and **Syntax Reference** tabs. Also wires up file open/save.
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
    'Gently it is done'
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
    setStatus('Booting WABT… 🐰', 'busy');
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

  function resetPanels() {
    $('result').className = 'result';
    $('result').textContent = 'Running…';
    $('tokens').textContent = '';
    $('ast').textContent = '';
    $('wat').textContent = '';
    $('il').textContent = '';
    $('printed').textContent = '';
    $('buildExeBtn').disabled = true;
  }

  function reportError(err) {
    const line = err && err.line;
    $('result').textContent = (line ? 'Error [Line ' + line + ']: ' : 'Error: ') + err.message;
    $('result').className = 'result err';
    setStatus('Failed ✗', 'err');
    highlightLine(line);
  }

  // Shared prefix of Run and Compile: lex -> parse -> generate WAT & CIL -> assemble WASM.
  // Populates Tokens/AST/WAT/IL panels. Never executes anything.
  async function compilePipeline() {
    await ensureToolchain();
    const source = editor.value;

    setStatus('Phase 1 — lexing & syllable audit…', 'busy');
    const tokens = HaikuCore.tokenize(source);
    $('tokens').textContent = JSON.stringify(tokens, null, 2);

    setStatus('Phase 2 — building AST…', 'busy');
    const ast = HaikuCore.parseProgram(tokens);
    $('ast').textContent = JSON.stringify(ast, null, 2);

    setStatus('Phase 3 — generating WAT & CIL, assembling WASM…', 'busy');
    const seed = Date.now();
    const wat = HaikuCore.generateWat(ast, seed);
    $('wat').textContent = wat;
    const il = HaikuCore.generateIl(ast, seed);
    $('il').textContent = il;

    const module = wabt.parseWat('repl.wat', wat);
    const { buffer } = module.toBinary({});
    $('buildExeBtn').disabled = false;

    return { ast, wat, il, wasmBuffer: buffer };
  }

  // Full pipeline: compile, then execute the assembled WASM.
  async function run() {
    resetPanels();
    try {
      const { wasmBuffer } = await compilePipeline();

      setStatus('Phase 4 — executing…', 'busy');
      const printed = [];
      const readInput = () => {
        const value = parseInt(window.prompt('Input:') || '', 10);
        return Number.isNaN(value) ? 0 : value;
      };
      const importObject = { env: { print: (v) => printed.push(v), input: readInput } };
      const { instance } = await WebAssembly.instantiate(wasmBuffer, importObject);

      const value = instance.exports.compute();
      $('printed').textContent = printed.length ? printed.join('\n') : '(none)';
      $('result').textContent = 'Result: ' + value;
      $('result').className = 'result ok';
      setStatus('Done ✓', 'ok');
    } catch (err) {
      reportError(err);
    }
  }

  // Same pipeline as Run, but stops after assembling — never executes, so no
  // input() prompts fire. Printed Output is still cleared by resetPanels(),
  // same as Run, so every click starts from a clean slate.
  async function compileOnly() {
    resetPanels();
    try {
      await compilePipeline();
      $('result').textContent = 'Compiled ✓ (not run)';
      $('result').className = 'result ok';
      setStatus('Compiled ✓', 'ok');
    } catch (err) {
      reportError(err);
    }
  }

  // POSTs the currently-displayed IL to the server's /build-exe route
  // (server.js, which shells out to ilasm.exe) and downloads the result.
  async function buildExe() {
    const il = $('il').textContent;
    if (!il) return;
    const btn = $('buildExeBtn');
    btn.disabled = true;
    setStatus('Building .exe…', 'busy');
    try {
      const resp = await fetch('/build-exe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ il })
      });
      if (!resp.ok) {
        let message = resp.statusText;
        try {
          const body = await resp.json();
          if (body && body.error) message = body.error;
        } catch {}
        throw new Error(message);
      }
      const blob = await resp.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'HaikuProgram.exe';
      a.click();
      URL.revokeObjectURL(a.href);
      setStatus('Built HaikuProgram.exe ✓', 'ok');
    } catch (err) {
      setStatus('Build failed: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
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

  // ---- Tabs ---------------------------------------------------------------
  function switchTab(name) {
    $('tabBtnRepl').classList.toggle('active', name === 'repl');
    $('tabBtnGrammar').classList.toggle('active', name === 'grammar');
    $('tabRepl').classList.toggle('active', name === 'repl');
    $('tabGrammar').classList.toggle('active', name === 'grammar');
  }

  // ---- Wiring ------------------------------------------------------------
  function init() {
    editor.value = DEFAULT_SOURCE;
    // Try to load the on-disk sample so the REPL mirrors the CLI's fibonacci.hk.
    fetch('/src/fibonacci.hk').then(r => r.ok ? r.text() : null).then(t => {
      if (t) { editor.value = t; fileName.textContent = 'fibonacci.hk'; }
    }).catch(() => {});

    // Static reference panel — fetched once at load, not tied to Run/Compile.
    fetch('/GRAMMAR.md').then(r => r.ok ? r.text() : null).then(t => {
      if (t) $('grammar').textContent = t;
    }).catch(() => {});

    $('tabBtnRepl').addEventListener('click', () => switchTab('repl'));
    $('tabBtnGrammar').addEventListener('click', () => switchTab('grammar'));

    $('runBtn').addEventListener('click', run);
    $('compileBtn').addEventListener('click', compileOnly);
    $('buildExeBtn').addEventListener('click', buildExe);
    $('openBtn').addEventListener('click', openFile);
    $('saveBtn').addEventListener('click', () => saveFile(false));
    $('saveAsBtn').addEventListener('click', () => saveFile(true));
    $('filePicker').addEventListener('change', openViaInput);

    editor.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'Enter') { e.preventDefault(); run(); }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Enter') { e.preventDefault(); compileOnly(); }
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
Served at `/repl.html`. Loads the shared core and the `wabt` assembler straight out of `node_modules`, then the REPL driver. A banner and two tabs — **REPL** and **Syntax Reference** — sit above the main grid; the Syntax Reference tab renders `GRAMMAR.md`, fetched once at load by `repl.js`. The toolbar has both **▶ Run** (Ctrl+Enter) and **⚙ Compile** (Ctrl+Shift+Enter). The CIL/IL panel's `<summary>` also hosts the **Build .exe** button, with an inline `onclick` that stops the click from bubbling up and collapsing the `<details>` panel. The **Printed Output** panel shows every value a `PrintStatement` surfaced mid-run, in order, above the final **Result**.
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HaikuScript REPL</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>%F0%9F%8C%B8</text></svg>">
  <style>
    /* Palette sampled from the banner art: slate ground, teal circuitry,
       cherry-blossom pink. The page commits to dark so the banner sits in
       its own world instead of floating on white. */
    :root {
      color-scheme: dark;
      --bg: #11161a;
      --surface: #1a2128;
      --surface-2: #212b33;
      --code-bg: #0e1317;
      --border: #2b3741;
      --border-soft: #222c34;
      --text: #e6edf3;
      --text-dim: #94a3af;
      --text-faint: #67747f;
      --accent: #35d0b5;
      --accent-hi: #55e5cb;
      --danger: #ff7d7d;
      --warn: #f0b45e;
      --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
      --radius: 10px;
      --shadow: 0 1px 2px rgba(0,0,0,.35), 0 14px 32px -18px rgba(0,0,0,.8);
    }
    * { box-sizing: border-box; }
    html { scrollbar-gutter: stable; }
    body {
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      margin: 0 auto;
      padding: 1.75rem 1.5rem 3rem;
      max-width: 1180px;
      background:
        radial-gradient(1100px 520px at 50% -8%, #1b2830 0%, transparent 70%),
        var(--bg);
      color: var(--text);
      line-height: 1.5;
      min-height: 100vh;
    }

    /* ---- Scrollbars ---- */
    * { scrollbar-width: thin; scrollbar-color: #38454f transparent; }
    ::-webkit-scrollbar { width: 11px; height: 11px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: #35424c; border-radius: 8px;
      border: 3px solid transparent; background-clip: content-box;
    }
    ::-webkit-scrollbar-thumb:hover { background: #475865; background-clip: content-box; }

    /* ---- Masthead ---- */
    .banner {
      display: flex; flex-direction: column; align-items: center; gap: .1rem;
      position: relative; isolation: isolate;
      padding: .9rem 1rem 1.1rem;
      margin-bottom: 1rem;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: linear-gradient(150deg, #1d262d 0%, #141a20 55%, #121a1e 100%);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    /* teal bloom behind the mark, echoing the art's glow */
    .banner::before {
      content: ""; position: absolute; z-index: -1; inset: 0;
      background: radial-gradient(460px 150px at 50% 45%, rgba(53,208,181,.13), transparent 72%);
    }
    /* The art carries its own dark ground, so feather all four edges into the
       card instead of letting its rectangle read as a pasted-on patch. */
    .banner img {
      max-width: min(702px, 100%); width: 100%; height: auto; display: block;
      -webkit-mask-image:
        linear-gradient(to right, transparent, #000 8%, #000 92%, transparent),
        linear-gradient(to bottom, transparent, #000 14%, #000 86%, transparent);
      -webkit-mask-composite: source-in;
      mask-image:
        linear-gradient(to right, transparent, #000 8%, #000 92%, transparent),
        linear-gradient(to bottom, transparent, #000 14%, #000 86%, transparent);
      mask-composite: intersect;
    }
    .banner .repl-tag {
      font-size: .72rem; font-weight: 700; letter-spacing: .22em; text-transform: uppercase;
      color: var(--accent); padding: .22rem .7rem; border-radius: 999px;
      border: 1px solid rgba(53,208,181,.35); background: rgba(53,208,181,.08);
    }

    p.sub {
      margin: 0 0 .7rem; text-align: center;
      color: var(--text-dim); font-size: .92rem;
    }
    p.sub strong { color: var(--text); font-weight: 600; }

    /* pipeline stage chips — a visual echo of the panels below */
    .pipeline {
      display: flex; flex-wrap: wrap; justify-content: center; align-items: center;
      gap: .35rem; margin: 0 0 1.4rem;
      font-family: var(--mono); font-size: .72rem;
    }
    .pipeline span {
      padding: .2rem .6rem; border-radius: 999px;
      background: var(--surface); border: 1px solid var(--border-soft); color: var(--text-dim);
    }
    .pipeline span:last-child { color: var(--accent); border-color: rgba(53,208,181,.3); }
    .pipeline i { color: var(--text-faint); font-style: normal; }

    /* ---- Toolbar ---- */
    .toolbar {
      display: flex; flex-wrap: wrap; gap: .45rem; align-items: center;
      padding: .55rem; margin-bottom: 1rem;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; box-shadow: var(--shadow);
    }
    .toolbar button {
      font: inherit; font-size: .88rem; font-weight: 500;
      display: inline-flex; align-items: center; gap: .4rem;
      padding: .45rem .85rem; border-radius: 7px; cursor: pointer;
      color: var(--text-dim); background: transparent;
      border: 1px solid transparent;
      transition: background .13s, color .13s, border-color .13s;
    }
    .toolbar button:hover { background: var(--surface-2); color: var(--text); }
    .toolbar button:active { transform: translateY(1px); }
    .toolbar button:focus-visible {
      outline: none; border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(53,208,181,.2);
    }
    #runBtn {
      background: linear-gradient(180deg, #3ad9bd, #23b79c);
      color: #06231d; font-weight: 700; border-color: #23b79c;
      box-shadow: 0 1px 0 rgba(255,255,255,.18) inset, 0 6px 14px -8px rgba(53,208,181,.9);
    }
    #runBtn:hover { background: linear-gradient(180deg, #4ee6ca, #2ac5a8); color: #06231d; }
    #compileBtn {
      color: var(--accent); border-color: rgba(53,208,181,.34);
      background: rgba(53,208,181,.07);
    }
    #compileBtn:hover { color: var(--accent-hi); background: rgba(53,208,181,.14); border-color: rgba(53,208,181,.55); }
    .tb-sep { width: 1px; height: 22px; background: var(--border); margin: 0 .3rem; }
    #fileName {
      margin-left: auto; font-family: var(--mono); font-size: .78rem;
      color: var(--text-dim); padding: .3rem .65rem;
      background: var(--code-bg); border: 1px solid var(--border-soft); border-radius: 6px;
    }

    /* ---- Tabs ---- */
    .tabs {
      display: flex; gap: .15rem;
      border-bottom: 1px solid var(--border); margin-bottom: 1.15rem;
    }
    .tab-btn {
      font: inherit; font-size: .9rem; font-weight: 600;
      padding: .6rem 1.15rem; cursor: pointer;
      color: var(--text-faint); background: none;
      border: none; border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      transition: color .13s, border-color .13s, background .13s;
    }
    .tab-btn:hover { color: var(--text-dim); background: rgba(255,255,255,.03); }
    .tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }
    .tab-btn:focus-visible { outline: none; color: var(--accent); background: rgba(53,208,181,.1); }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }

    /* ---- Layout ---- */
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 1.1rem;
      align-items: start;
    }
    @media (max-width: 860px) { .grid { grid-template-columns: minmax(0, 1fr); } }
    @media (min-width: 861px) { .editor-col { position: sticky; top: 1rem; } }

    /* ---- Editor ---- */
    textarea {
      width: 100%; min-height: 440px;
      font-family: var(--mono); font-size: .95rem; line-height: 1.8;
      padding: 1rem 1.15rem;
      color: #e9f2ef; background: var(--code-bg);
      border: 1px solid var(--border); border-radius: var(--radius);
      resize: vertical; box-shadow: var(--shadow);
      transition: border-color .13s, box-shadow .13s;
    }
    textarea:focus {
      outline: none; border-color: rgba(53,208,181,.5);
      box-shadow: 0 0 0 3px rgba(53,208,181,.14), var(--shadow);
    }
    textarea::selection { background: rgba(53,208,181,.28); }

    .status {
      display: flex; align-items: center; gap: .5rem;
      margin: .7rem .2rem 0; min-height: 1.4em;
      font-family: var(--mono); font-size: .78rem; color: var(--text-dim);
    }
    .status::before {
      content: ""; flex: none; width: 7px; height: 7px; border-radius: 50%;
      background: var(--text-faint);
    }
    .status.busy { color: var(--warn); }
    .status.busy::before { background: var(--warn); animation: pulse 1.1s ease-in-out infinite; }
    .status.ok { color: var(--accent); }
    .status.ok::before { background: var(--accent); }
    .status.err { color: var(--danger); }
    .status.err::before { background: var(--danger); }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }

    /* ---- Result ---- */
    .result {
      font-size: 1.35rem; font-weight: 700; line-height: 1.35;
      padding: .9rem 1.1rem; margin-bottom: .9rem;
      color: var(--text-dim);
      background: var(--surface);
      border: 1px solid var(--border); border-left: 4px solid var(--text-faint);
      border-radius: var(--radius); box-shadow: var(--shadow);
      word-break: break-word;
    }
    .result.ok {
      color: var(--accent-hi); border-left-color: var(--accent);
      background: linear-gradient(90deg, rgba(53,208,181,.12), var(--surface) 60%);
    }
    .result.err {
      font-size: 1rem; font-weight: 600;
      color: var(--danger); border-left-color: var(--danger);
      background: linear-gradient(90deg, rgba(255,125,125,.12), var(--surface) 60%);
    }

    /* ---- Output panels ---- */
    details {
      background: var(--surface);
      border: 1px solid var(--border); border-radius: var(--radius);
      margin-bottom: .6rem; overflow: hidden;
    }
    details[open] { box-shadow: var(--shadow); }
    summary {
      display: flex; align-items: center; gap: .55rem;
      padding: .6rem .85rem; cursor: pointer; user-select: none;
      font-size: .87rem; font-weight: 600; color: var(--text);
      transition: background .13s;
    }
    summary:hover { background: var(--surface-2); }
    summary:focus-visible { outline: none; background: var(--surface-2); box-shadow: inset 3px 0 0 var(--accent); }
    summary::-webkit-details-marker { display: none; }
    summary::before {
      content: ""; flex: none;
      width: 6px; height: 6px; margin-left: .1rem;
      border-right: 1.8px solid var(--text-faint); border-bottom: 1.8px solid var(--text-faint);
      transform: rotate(-45deg); transition: transform .16s ease, border-color .16s;
    }
    details[open] > summary::before { transform: rotate(45deg); border-color: var(--accent); }
    #buildExeBtn {
      font: inherit; font-size: .74rem; font-weight: 600;
      margin-left: auto; padding: .28rem .7rem; border-radius: 999px; cursor: pointer;
      color: var(--accent); background: rgba(53,208,181,.09);
      border: 1px solid rgba(53,208,181,.34);
      transition: background .13s, color .13s, border-color .13s;
    }
    #buildExeBtn:hover:not(:disabled) {
      color: var(--accent-hi); background: rgba(53,208,181,.18); border-color: rgba(53,208,181,.6);
    }
    #buildExeBtn:disabled {
      color: var(--text-faint); background: transparent;
      border-color: var(--border); cursor: not-allowed; opacity: .65;
    }
    pre {
      margin: 0; padding: .85rem 1rem;
      max-height: 360px; overflow: auto;
      font-family: var(--mono); font-size: .79rem; line-height: 1.65;
      color: #cfdcd9; background: var(--code-bg);
      border-top: 1px solid var(--border-soft);
    }
    pre:empty::before {
      content: "—"; color: var(--text-faint);
    }

    /* ---- Syntax reference tab ---- */
    #grammar {
      white-space: pre-wrap; word-wrap: break-word;
      max-height: none; padding: 1.4rem 1.6rem;
      font-size: .84rem; line-height: 1.75;
      border: 1px solid var(--border); border-radius: var(--radius);
      box-shadow: var(--shadow);
    }
  </style>
</head>
<body>
  <div class="banner">
    <img src="/assets/Banner2.png" alt="HaikuScript">
    <span class="repl-tag">REPL</span>
  </div>
  <p class="sub">Write the poem, press <strong>Run</strong> — every stage runs in your browser.</p>
  <div class="pipeline">
    <span>lex</span><i>→</i><span>syllable audit</span><i>→</i><span>AST</span><i>→</i><span>WAT</span><i>→</i><span>WASM</span><i>→</i><span>execute</span>
  </div>

  <div class="toolbar">
    <button id="runBtn" title="Ctrl+Enter">▶ Run</button>
    <button id="compileBtn" title="Ctrl+Shift+Enter">⚙ Compile</button>
    <span class="tb-sep"></span>
    <button id="openBtn">Open…</button>
    <button id="saveBtn" title="Ctrl+S">Save</button>
    <button id="saveAsBtn">Save As…</button>
    <span id="fileName">untitled.hk</span>
    <input id="filePicker" type="file" accept=".hk,text/plain" hidden>
  </div>

  <div class="tabs">
    <button class="tab-btn active" id="tabBtnRepl" data-tab="repl">REPL</button>
    <button class="tab-btn" id="tabBtnGrammar" data-tab="grammar">Syntax Reference</button>
  </div>

  <div id="tabRepl" class="tab-panel active">
    <div class="grid">
      <div class="editor-col">
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
        <details>
          <summary>CIL / IL (ildasm-style) <button id="buildExeBtn" disabled onclick="event.preventDefault(); event.stopPropagation();">Build .exe</button></summary>
          <pre id="il"></pre>
        </details>
      </div>
    </div>
  </div>

  <div id="tabGrammar" class="tab-panel">
    <pre id="grammar"></pre>
  </div>

  <!-- Shared compiler core, then the WABT assembler, then the REPL driver -->
  <script src="/haiku-core.js"></script>
  <script src="/node_modules/wabt/index.js"></script>
  <script src="/repl.js"></script>
</body>
</html>
```

## 8. REPL Server (`server.js`)
Zero-dependency Node script (built-ins only) that replaced the old `serve` package. Two responsibilities: serve the project's static files (`serveStatic`, `/` maps to `/index.html`, an extensionless path falls back to its `.html` sibling so `serve`'s old "clean URLs" like `/repl` still resolve — browsers cache that package's `/repl.html` → `/repl` 301 indefinitely, so a correct link would otherwise 404 — malformed URLs get a 400 instead of an uncaught `URIError`, and the path-traversal guard checks `filePath.startsWith(ROOT + path.sep)` — a real directory boundary, not a string-prefix check that a sibling directory like `../haikuscript-secrets` could slip past); and handle `POST /build-exe` (`handleBuildExe`), which writes the posted IL text to a temp `.il` file, shells out to `ilasm.exe` (`execFile`, path from `ILASM_PATH` or the default Windows .NET Framework location) to assemble it into a real `.exe`, streams the `.exe` bytes back as the response, and cleans up the temp `.il`/`.exe`/`.pdb` files it created. Binds to `127.0.0.1` only, since this route runs an external process against arbitrary POSTed text and shouldn't be reachable from the LAN.
```javascript
// Static file server for the HaikuScript REPL, plus one POST route that
// shells out to ilasm.exe to build a real .exe from generated IL text.
// Zero npm dependencies — Node built-ins only.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;
const ILASM_PATH = process.env.ILASM_PATH ||
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\ilasm.exe';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.hk': 'text/plain', '.md': 'text/plain',
  '.wasm': 'application/wasm', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.ico': 'image/x-icon'
};

function sendFile(res, filePath, onMissing) {
  fs.readFile(filePath, (err, data) => {
    if (err) return onMissing();
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

function notFound(res) { res.writeHead(404); res.end('Not found'); }

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) { res.writeHead(403); return res.end(); }
  sendFile(res, filePath, () => {
    // The `serve` package this replaced answered extensionless "clean URLs"
    // (/repl -> repl.html) and 301'd /repl.html to /repl. Browsers cache 301s
    // indefinitely, so anyone who ran the old setup still gets silently sent
    // to /repl — resolve those here instead of 404ing on a correct link.
    if (path.extname(filePath)) return notFound(res);
    sendFile(res, filePath + '.html', () => notFound(res));
  });
}

function handleBuildExe(req, res) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let il;
    try { il = JSON.parse(body).il; } catch { il = null; }
    if (typeof il !== 'string' || !il) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing "il" in request body' }));
    }

    const id = crypto.randomBytes(6).toString('hex');
    const tmpDir = os.tmpdir();
    const ilPath = path.join(tmpDir, `haiku-${id}.il`);
    const exePath = path.join(tmpDir, `haiku-${id}.exe`);

    fs.writeFile(ilPath, il, (writeErr) => {
      if (writeErr) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: writeErr.message }));
      }

      execFile(ILASM_PATH, [ilPath, '/exe', `/output:${exePath}`], (ilasmErr, stdout, stderr) => {
        fs.unlink(ilPath, () => {});
        if (ilasmErr) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: stderr || stdout || ilasmErr.message }));
        }
        fs.readFile(exePath, (readErr, exeData) => {
          fs.unlink(exePath, () => {});
          fs.unlink(exePath.replace(/\.exe$/, '.pdb'), () => {});
          if (readErr) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: readErr.message }));
          }
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': 'attachment; filename="HaikuProgram.exe"'
          });
          res.end(exeData);
        });
      });
    });
  });
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/build-exe') return handleBuildExe(req, res);
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405);
  res.end();
}).listen(PORT, '127.0.0.1', () => {
  console.log(`HaikuScript REPL server: http://localhost:${PORT}/repl.html`);
});
```

## 9. VS Code IDE Extension Connector (`vsc-extension/extension.js`)
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

## 10. Web Sandbox Test Harness (`index.html`)
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

## 11. Source Poetry Input Code (`src/fibonacci.hk`)
All sample poems now live under `src/` — `fibonacci.hk` (below), plus `test_digits.hk` (digit-literal variant of the same program), `named_vars.hk` and `syllable_check.hk` (exercise the short named-identifier feature in §4), `ten_randoms.hk` (loop + `PrintStatement` demo, printing ten random draws instead of only the final `x`), `input_demo.hk` (exercises all four `INPUT` keywords — `guess`, `ask user`, `prompt`, and `set ... to input` — reading four values back with `PrintStatement`), `guess_number.hk` (a minimal guessing game combining all of the above — `loop until g equals s` keeps reading guesses until one matches a random secret, then prints the winning guess and how many tries it took, with no hints), `comparisons_demo.hk` (five self-contained counting loops exercising `<`, `>`, `and`, `or`, and `xor` — each printing a predictable result that proves the operator behaves correctly, including the `xor`-vs-`or` discrimination case where both terms are true simultaneously), `higher_lower.hk` (a real higher/lower guessing game using `if`/`else if`/`else` to print a hint after every wrong guess — nested `if`s inside the `else` branch skip the hint entirely on the winning guess, a fix for the "iteration ordering" bug that showed up when the naive version printed a misleading hint on the correct guess itself), and `while_demo.hk` (two counting loops proving `while`'s inverted polarity against `until` — a single-term `while a1 less than ten`, and a multi-term `while a1 less than ten and b less than ten` confirming the negation applies to the whole and/or/xor chain at once, not to one term of it).
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
Gently it is done
```
