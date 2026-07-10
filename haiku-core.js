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
    "something": { syllables: 2, type: "RANDOM" }
  };

  const EXPECTED_METER = [5, 7, 5];

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
      0, 1, 1, 1, 1, 1, 1, 2, 1, 1, // 0-9
      1, 3, 1, 2, 2, 2, 2, 3, 2, 2  // 10-19
    ];
    const tensSyllables = [
      0, 0, 2, 2, 2, 2, 2, 3, 2, 2  // 0-90
    ];

    let count = 0;
    let originalN = n;

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
      const words = cleanLine.match(/[a-zA-Z]+|[0-9]+/g);
      if (!words) continue; // blank / word-less line — not a code line

      const currentLineNum = row + 1;
      const expected = EXPECTED_METER[lineIndex % 3];
      let runningSyllables = 0;

      for (const rawWord of words) {
        const wordText = rawWord.toLowerCase();

        if (/^[0-9]+$/.test(wordText)) {
          const val = parseInt(wordText, 10);
          runningSyllables += getNumberSyllables(val);
          tokens.push({
            type: "NUMBER",
            value: val,
            line: currentLineNum
          });
          continue;
        }

        if (!VOCAB[wordText]) {
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
      if (node.type === "WhileLoopStatement") {
        let out = `${indent}block\n${indent}loop\n`;
        indent += "  ";
        out += `${indent}local.get $${node.condition.left}\n${indent}i32.const ${node.condition.right}\n${indent}i32.eq\n${indent}br_if 1\n`;
        node.body.forEach(c => { out += walk(c); });
        out += `${indent}br 0\n`;
        indent = indent.substring(0, indent.length - 2);
        return out + `${indent}end\n${indent}end\n`;
      }
      return "";
    }

    ast.body.forEach(n => { watBody += walk(n); });

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
    return `(module\n${prng}  (func $compute (result i32)\n    (local $x i32) (local $y i32) (local $z i32) (local $count i32)\n\n${watBody}\n    local.get $x\n  )\n  (export "compute" (func $compute))\n)`;
  }

  return { VOCAB, EXPECTED_METER, HaikuError, tokenize, parseProgram, generateWat };
});