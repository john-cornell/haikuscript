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
    "languages": [{
      "id": "haikuscript",
      "aliases": ["HaikuScript"],
      "extensions": [".hk"]
    }]
  },
  "scripts": {
    "build-parser": "npx tree-sitter generate && npx tree-sitter build --wasm",
    "tokens": "node haiku.js --dump-tokens fibonacci.hk",
    "ast": "node haiku.js --dump-ast fibonacci.hk",
    "compile": "node haiku.js --compile fibonacci.hk",
    "serve": "serve .",
    "repl": "serve ."
  },
  "devDependencies": {
    "tree-sitter-cli": "^0.26.10"
  },
  "dependencies": {
    "serve": "^14.2.1",
    "wabt": "^1.0.36",
    "web-tree-sitter": "^0.20.8"
  }
}
```

## 2. Tree-sitter Structural Rules (`grammar.js`)
```javascript
module.exports = grammar({
  name: 'haikuscript',
  
  // Ignore spaces and tabs, but keep newlines strictly structural
  extras: $ => [/[ \t\r]+/], 

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

    // A word is any collection of letters
    word: $ => /[a-zA-Z]+/,

    newline: $ => /\n/
  }
});
```

## 3. Tree-sitter Syntax Highlight Matchers (`queries/highlights.scm`)
```query
; Use Tree-sitter predicates to map plain words to official editor syntax tokens
((word) @keyword
  (#match? @keyword "^(set|to|add|loop|until|equals|end)$"))

((word) @keyword.function
  (#match? @keyword.function "^(dream|imagine|random|randomly|something)$"))

((word) @number
  (#match? @number "^(zero|one|ten)$"))

((word) @comment
  (#match? @comment "^(the|is|it|quietly|gently|suddenly|always|beautifully|telling|sequence)$"))

((word) @variable
  (#match? @variable "^(x|y|z|count)$"))
```

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

  // PHASE 1: Semantic Analysis (Syllable Auditing).
  // Takes a parsed Tree-sitter `tree` plus its `Lang` (same object shape in Node
  // and browser web-tree-sitter) and returns the token stream. Throws HaikuError.
  function tokenize(tree, Lang) {
    const query = Lang.query('(line) @line');
    const matches = query.matches(tree.rootNode);

    const tokens = [];
    let lineIndex = 0;

    for (const match of matches) {
      const lineNode = match.captures[0].node;
      const currentLineNum = lineNode.startPosition.row + 1;
      const expected = EXPECTED_METER[lineIndex % 3];
      let runningSyllables = 0;

      for (let i = 0; i < lineNode.childCount; i++) {
        const wordText = lineNode.child(i).text.toLowerCase();

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
```

## 5. Compiler Pipeline CLI (`haiku.js`)
Node entry point. Owns the Tree-sitter frontend, file I/O, and CLI flags (`--dump-tokens`, `--dump-ast`, `--compile`, `--json-errors`); delegates all compilation to the shared core.
```javascript
const fs = require('fs');
const path = require('path');
const Parser = require('web-tree-sitter');
const { tokenize, parseProgram, generateWat, HaikuError } = require('./haiku-core');

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
  // Initialize Tree-sitter WASM components
  await Parser.init();
  const parser = new Parser();
  const Lang = await Parser.Language.load(path.join(__dirname, 'tree-sitter-haikuscript.wasm'));
  parser.setLanguage(Lang);

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
  const tree = parser.parse(sourceCode);

  // PHASE 1: Semantic Analysis (Syllable Auditing) — shared core, CLI-style reporting
  let tokens;
  try {
    tokens = tokenize(tree, Lang);
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

  // PHASE 3: Code Generation & Automated Binary Assembly
  if (flag === '--compile') {
    const fullWat = generateWat(ast, Date.now());

    // Write out the human-readable WebAssembly Text Blueprint
    fs.writeFileSync(targetFile.replace('.hk', '.wat'), fullWat);
    console.log(`\x1b[32mSuccessfully compiled to WebAssembly Text (.wat)!\x1b[0m`);

    // Compile directly into native browser-executable WASM binary bytes using WABT
    try {
      const wasmModule = wabt.parseWat(targetFile, fullWat);
      const { buffer } = wasmModule.toBinary({});
      fs.writeFileSync(targetFile.replace('.hk', '.wasm'), Buffer.from(buffer));
      console.log(`\x1b[32mSuccessfully assembled to WebAssembly Binary (.wasm)!\x1b[0m`);
    } catch (wasmErr) {
      console.error(`\x1b[31mAssembly Error: ${wasmErr.message}\x1b[0m`);
    }
  }
}

runCompiler();
```

## 6. Browser REPL Driver (`repl.js`)
Runs the whole pipeline client-side: Tree-sitter (web build) parses the editor text, the shared core audits/parses/generates, WABT assembles WASM in-browser, and `WebAssembly.instantiate` executes it. Also wires up file open/save.
```javascript
// HaikuScript browser REPL — runs the full compiler pipeline client-side.
// Globals provided by the <script> tags in repl.html:
//   HaikuCore    (haiku-core.js)
//   TreeSitter   (web-tree-sitter/tree-sitter.js)
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

  let parser = null;   // Tree-sitter parser (lazily initialised, reused across runs)
  let Lang = null;     // Loaded HaikuScript grammar
  let wabt = null;     // WABT instance
  let fileHandle = null; // File System Access API handle, when available

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = 'status' + (kind ? ' ' + kind : '');
  }

  // Lazily boot the heavy WASM toolchains exactly once.
  async function ensureToolchain() {
    if (parser && wabt) return;
    setStatus('Booting Tree-sitter + WABT…', 'busy');
    if (!parser) {
      await TreeSitter.init({ locateFile: (name) => '/' + name });
      parser = new TreeSitter();
      Lang = await TreeSitter.Language.load('/tree-sitter-haikuscript.wasm');
      parser.setLanguage(Lang);
    }
    if (!wabt) {
      wabt = await WabtModule();
    }
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

    try {
      await ensureToolchain();
      const source = editor.value;

      setStatus('Phase 1 — parsing & syllable audit…', 'busy');
      const tree = parser.parse(source);
      const tokens = HaikuCore.tokenize(tree, Lang);
      $('tokens').textContent = JSON.stringify(tokens, null, 2);

      setStatus('Phase 2 — building AST…', 'busy');
      const ast = HaikuCore.parseProgram(tokens);
      $('ast').textContent = JSON.stringify(ast, null, 2);

      setStatus('Phase 3 — generating WAT & assembling WASM…', 'busy');
      const wat = HaikuCore.generateWat(ast, Date.now());
      $('wat').textContent = wat;

      const module = wabt.parseWat('repl.wat', wat);
      const { buffer } = module.toBinary({});
      const { instance } = await WebAssembly.instantiate(buffer);

      const value = instance.exports.compute();
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
    fetch('/fibonacci.hk').then(r => r.ok ? r.text() : null).then(t => {
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
Served at `/repl.html`. Loads the shared core, the two WASM toolchains (`web-tree-sitter`, `wabt`) straight out of `node_modules`, then the REPL driver.
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

  <!-- Shared compiler core, then the two WASM toolchains, then the REPL driver -->
  <script src="/haiku-core.js"></script>
  <script src="/node_modules/web-tree-sitter/tree-sitter.js"></script>
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
A minimal single-shot page that fetches the pre-compiled `fibonacci.wasm` and renders the result on screen (and to the console).
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
        const serverResponse = await fetch('fibonacci.wasm');
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

## 10. Source Poetry Input Code (`fibonacci.hk`)
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
