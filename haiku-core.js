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
    "quietly": { syllables: 3, type: "IGNORE" },
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

    const lines = source.split('\n');
    for (let row = 0; row < lines.length; row++) {
      const cleanLine = lines[row].replace(/,/g, '');
      const words = cleanLine.match(/[a-zA-Z]{3,}|[a-zA-Z][a-zA-Z0-9]?|[0-9]+/g);
      if (!words) continue; // blank / word-less line — not a code line

      const currentLineNum = row + 1;
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
      if (token.type === "LOOP" || token.type === "UNTIL") {
        // "until" implies a loop on its own — "loop" is just the explicit form.
        // Consumes whichever token triggered entry, then optionally skips a
        // following UNTIL (only present when LOOP started it): "Loop until x
        // equals y" and bare "Until x equals y" both land here and parse the
        // same way.
        current++; if (tokens[current] && tokens[current].type === "UNTIL") current++;
        const terms = parseCondition();
        const node = { type: "WhileLoopStatement", condition: { terms }, body: [] };

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

  return { VOCAB, EXPECTED_METER, HaikuError, tokenize, parseProgram, generateWat };
});