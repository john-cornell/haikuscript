# REPL Syntax Tab, Compile Button, and .exe Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Syntax Reference panel, a Compile-without-executing button, and a Build .exe feature to the HaikuScript REPL, per `docs/superpowers/specs/2026-08-11-repl-syntax-compile-exe-design.md`.

**Architecture:** The REPL's `run()` pipeline is split into a shared `compilePipeline()` (tokenize → parse → generateWat → generateIl → wabt-assemble) called by both the existing `run()` (which then executes) and a new `compileOnly()` (which stops after assembling). `generateIl` is upgraded from illustrative-only text to genuinely `ilasm`-buildable IL (assembly manifest, a real `HaikuHost` class backed by `System.Console`, and a `Main` entry point). A new zero-dependency `server.js` replaces the `serve` static-file package, adding a `POST /build-exe` route that shells out to `ilasm.exe` and streams back a real `.exe`. A static Syntax Reference panel renders `GRAMMAR.md` as plain text.

**Tech Stack:** Plain JavaScript (`haiku-core.js`/`repl.js`, no new npm dependencies), Node built-ins only for `server.js` (`http`, `fs`, `path`, `os`, `crypto`, `child_process`), `ilasm.exe` (ships with the Windows .NET Framework — confirmed present at `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\ilasm.exe`, no install needed).

## Global Constraints

- No new npm dependencies anywhere in this plan (`server.js` uses only Node built-ins; the `serve` package dependency is removed).
- No changes to `tokenize`, `parseProgram`, the AST node shapes, or `generateWat`.
- `generateIl`'s output must remain a superset-compatible extension of its current shape — every existing instruction-emission path (`walk`, `emitCondition`, `OPCODE_SIZE`, `resolveAddresses`, `renderInstrs`) is reused as-is for the new `HaikuHost`/`Main` methods, not reimplemented.
- The IL panel becomes genuinely `ilasm`-buildable (this supersedes the original IL-backend spec's "illustrative-only, nothing assembled" constraint — see `docs/superpowers/specs/2026-08-11-repl-syntax-compile-exe-design.md`'s Purpose section for why).
- `Compile` must never call `WebAssembly.instantiate` and must never trigger a `window.prompt` (no `input()` prompts fire).
- Both `Run` and `Compile` must populate Tokens/AST/WAT/IL panels identically — the only difference is whether execution happens afterward.
- `server.js` must serve static files with the same behavior developers currently get from `npm run serve` (i.e. `serve .`: default to `index.html`/`repl.html`, correct MIME types for `.html`/`.js`/`.css`/`.json`/`.hk`/`.md`/`.wasm`/`.jpg`).
- No automated test suite exists in this repo (no jest/mocha, no `test` npm script) — don't add a test framework. Verification is via Node scripts run directly against `haiku-core.js`/`server.js`, plus a manual browser check.

---

### Task 1: Syntax Reference panel

**Files:**
- Modify: `repl.html:88-93` (add a new `<details>` panel after the IL panel)
- Modify: `repl.js:178-183` (fetch `GRAMMAR.md` once at page load)

**Interfaces:**
- Consumes: nothing new — a plain `fetch('/GRAMMAR.md')`.
- Produces: nothing later tasks depend on. Fully independent of Tasks 2-5.

- [ ] **Step 1: Add the panel to `repl.html`**

Open `repl.html`. The panel list currently ends with (around line 88):

```html
      <details>
        <summary>CIL / IL (ildasm-style)</summary>
        <pre id="il"></pre>
      </details>
    </div>
  </div>
```

Replace it with:

```html
      <details>
        <summary>CIL / IL (ildasm-style)</summary>
        <pre id="il"></pre>
      </details>
      <details>
        <summary>Syntax Reference (GRAMMAR.md)</summary>
        <pre id="grammar"></pre>
      </details>
    </div>
  </div>
```

- [ ] **Step 2: Fetch `GRAMMAR.md` once at load, in `repl.js`**

Open `repl.js`. `init()` currently reads (around line 178):

```js
  function init() {
    editor.value = DEFAULT_SOURCE;
    // Try to load the on-disk sample so the REPL mirrors the CLI's fibonacci.hk.
    fetch('/src/fibonacci.hk').then(r => r.ok ? r.text() : null).then(t => {
      if (t) { editor.value = t; fileName.textContent = 'fibonacci.hk'; }
    }).catch(() => {});
```

Add immediately after that `fetch` block (still inside `init()`, before the `$('runBtn').addEventListener(...)` line):

```js

    // Static reference panel — fetched once at load, not tied to Run/Compile.
    fetch('/GRAMMAR.md').then(r => r.ok ? r.text() : null).then(t => {
      if (t) $('grammar').textContent = t;
    }).catch(() => {});
```

- [ ] **Step 3: Verify by serving and fetching directly**

Run:

```bash
cd /mnt/c/Code/Fizzbash/haikuscript
node node_modules/serve/build/main.js . &
SERVER_PID=$!
sleep 1
grep -c 'id="grammar"' repl.html
grep -c "fetch('/GRAMMAR.md')" repl.js
curl -s http://localhost:3000/GRAMMAR.md | head -3
curl -s http://localhost:3000/GRAMMAR.md | wc -l
kill $SERVER_PID
```

Expected: both `grep -c` calls print `1`; the `curl` calls print the first lines of `GRAMMAR.md` (its title heading) and a line count matching `wc -l GRAMMAR.md`'s own output. This confirms the wiring; a full visual check (open `http://localhost:3000/repl.html`, expand the new panel, confirm the text matches `GRAMMAR.md`) should also be done in a browser if one is available in your environment — if not, note that in your report and the controller will verify it.

- [ ] **Step 4: Commit**

```bash
cd /mnt/c/Code/Fizzbash/haikuscript
git add repl.html repl.js
git commit -m "Add Syntax Reference panel to the REPL"
```

---

### Task 2: Compile button (compile without executing)

**Files:**
- Modify: `repl.html` (toolbar: add a `Compile` button next to `Run`)
- Modify: `repl.js:56-107` (split `run()` into `resetPanels()` + `compilePipeline()` + `reportError()` + `run()`, and add `compileOnly()`)

**Interfaces:**
- Consumes: `HaikuCore.tokenize`, `HaikuCore.parseProgram`, `HaikuCore.generateWat`, `HaikuCore.generateIl` (all existing), `wabt.parseWat`/`module.toBinary` (existing `ensureToolchain()`/`wabt` global).
- Produces: `compilePipeline()` — `async function compilePipeline(): Promise<{ast, wat, il, wasmBuffer}>`, throws on any tokenize/parse/assemble error (same `HaikuError`-or-generic-`Error` shape `run()` already handles). `resetPanels()` — `function resetPanels(): void`. `reportError(err)` — `function reportError(err): void`. Task 5 (Build .exe wiring) calls `compilePipeline()`'s result indirectly by reading `$('il').textContent` after either `run()` or `compileOnly()` finishes, and calls `resetPanels()`'s side effects to know when to disable its button — Task 5 modifies `resetPanels()` directly to add that.

- [ ] **Step 1: Add the Compile button to `repl.html`**

Open `repl.html`. The toolbar currently reads (around line 56):

```html
  <div class="toolbar">
    <button id="runBtn" title="Ctrl+Enter">▶ Run</button>
    <button id="openBtn">Open…</button>
```

Replace it with:

```html
  <div class="toolbar">
    <button id="runBtn" title="Ctrl+Enter">▶ Run</button>
    <button id="compileBtn" title="Ctrl+Shift+Enter">⚙ Compile</button>
    <button id="openBtn">Open…</button>
```

- [ ] **Step 2: Replace `run()` with the split pipeline**

Open `repl.js`. Replace the entire existing `run()` function (currently lines 56-107, from `// Full pipeline: parse -> audit/tokenize -> AST -> WAT -> WASM -> execute.` through its closing `}`) with:

```js
  function resetPanels() {
    $('result').className = 'result';
    $('result').textContent = 'Running…';
    $('tokens').textContent = '';
    $('ast').textContent = '';
    $('wat').textContent = '';
    $('il').textContent = '';
    $('printed').textContent = '';
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
  // input() prompts fire and Printed Output is left untouched.
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
```

- [ ] **Step 3: Wire the button and the keyboard shortcut**

In `repl.js`'s `init()`, the wiring block currently reads:

```js
    $('runBtn').addEventListener('click', run);
    $('openBtn').addEventListener('click', openFile);
```

Replace it with:

```js
    $('runBtn').addEventListener('click', run);
    $('compileBtn').addEventListener('click', compileOnly);
    $('openBtn').addEventListener('click', openFile);
```

Then, still in `init()`, the keydown handler currently reads:

```js
    editor.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(false); }
    });
```

Replace it with (note the added `!e.shiftKey` on the `run()` branch — without it, Ctrl+Shift+Enter would fire **both** `run()` and `compileOnly()`, since the plain-Enter condition doesn't check `shiftKey` on its own):

```js
    editor.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'Enter') { e.preventDefault(); run(); }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Enter') { e.preventDefault(); compileOnly(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(false); }
    });
```

- [ ] **Step 4: Verify the pipeline logic with a Node simulation**

Since `compilePipeline()`/`compileOnly()` use browser globals (`wabt`, `WebAssembly`, `window`, `document`), they can't run directly under plain Node. Verify the underlying compiler-only logic they rely on (no execution) with:

```bash
cd /mnt/c/Code/Fizzbash/haikuscript
cat > /tmp/compile-only-check.js << 'EOF'
const { tokenize, parseProgram, generateWat, generateIl } = require('./haiku-core');
const fs = require('fs');
const wabtInit = require('wabt');

wabtInit().then((wabt) => {
  const source = fs.readFileSync('src/fibonacci.hk', 'utf8');
  const tokens = tokenize(source);
  const ast = parseProgram(tokens);
  const seed = 999;
  const wat = generateWat(ast, seed);
  const il = generateIl(ast, seed);
  const module = wabt.parseWat('check.wat', wat);
  const { buffer } = module.toBinary({});
  if (!(buffer instanceof Uint8Array) || buffer.length === 0) throw new Error('expected a non-empty WASM buffer');
  if (!il.includes('.class private auto ansi HaikuProgram')) throw new Error('expected IL class wrapper');
  console.log('OK: tokenize/parse/generateWat/generateIl/assemble all succeeded without executing anything, buffer length ' + buffer.length);
});
EOF
node /tmp/compile-only-check.js
rm /tmp/compile-only-check.js
```

Expected: `OK: tokenize/parse/generateWat/generateIl/assemble all succeeded without executing anything, buffer length <N>`.

Then grep-verify the shape of the new functions and the shift-key fix:

```bash
grep -n "async function compileOnly" repl.js
grep -n "WebAssembly.instantiate" repl.js
grep -n "!e.shiftKey" repl.js
```

Expected: `compileOnly` is found; `WebAssembly.instantiate` appears exactly once, inside `run()` (confirm by eye that it is NOT inside `compileOnly()`); `!e.shiftKey` is found in the keydown handler.

Note in your report that the button click / no-prompt-fires / panels-populate behavior itself needs a real browser to fully confirm — if you don't have one available, say so explicitly rather than claiming it works from static checks alone.

- [ ] **Step 5: Commit**

```bash
cd /mnt/c/Code/Fizzbash/haikuscript
git add repl.html repl.js
git commit -m "Add Compile button that assembles without executing"
```

---

### Task 3: Upgrade `generateIl` to real, `ilasm`-buildable IL

**Files:**
- Modify: `haiku-core.js:542-762` (the `generateIl` function)

**Interfaces:**
- Consumes: `resolveAddresses(instrs)`, `renderInstrs(instrs, labelAddr, indent)`, `OPCODE_SIZE` (all existing, defined earlier in `generateIl`).
- Produces: `generateIl(ast, seed)`'s return value now includes a `.assembly`/`.module` manifest, a `HaikuHost` class with real `Print`/`Input` implementations, and a `HaikuProgram::Main` entry point with `.entrypoint`. The existing `Compute()`/`NextRandom()`/`.cctor()` bodies and the `walk()`/`emitCondition()` call-site text (`HaikuProgram::NextRandom()`, `HaikuHost::Print(int32)`, `HaikuHost::Input()`) are unchanged — those calls now resolve to the real methods instead of undefined placeholders. No later task depends on any new named export.

- [ ] **Step 1: Add the `ldarg.0` opcode size**

Open `haiku-core.js`. Inside `generateIl`, the `OPCODE_SIZE` table currently reads (around line 660):

```js
    const OPCODE_SIZE = {
      'ldc.i4.m1': 1, 'ldc.i4.0': 1, 'ldc.i4.1': 1, 'ldc.i4.2': 1, 'ldc.i4.3': 1,
      'ldc.i4.4': 1, 'ldc.i4.5': 1, 'ldc.i4.6': 1, 'ldc.i4.7': 1, 'ldc.i4.8': 1,
      'ldc.i4.s': 2, 'ldc.i4': 5,
      'ldloc.0': 1, 'ldloc.1': 1, 'ldloc.2': 1, 'ldloc.3': 1, 'ldloc.s': 2,
      'stloc.0': 1, 'stloc.1': 1, 'stloc.2': 1, 'stloc.3': 1, 'stloc.s': 2,
      add: 1, ceq: 2, clt: 2, cgt: 2, and: 1, or: 1, xor: 1, ret: 1,
      shl: 1, 'shr.un': 1, 'rem.un': 1,
      'brfalse.s': 2, 'brtrue.s': 2, 'br.s': 2,
      call: 5, ldsfld: 5, stsfld: 5
    };
```

Replace it with (only the new `'ldarg.0': 1,` line is added — needed for `HaikuHost::Print(int32 v)`'s `ldarg.0`, which loads its one argument):

```js
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
```

- [ ] **Step 2: Build the `HaikuHost::Print`, `HaikuHost::Input`, and `HaikuProgram::Main` instruction lists**

Still in `generateIl`, find this block (around line 731):

```js
    const rngLabelAddr = resolveAddresses(rngInstrs);
    const rngText = renderInstrs(rngInstrs, rngLabelAddr, '    ');
    const cctorLabelAddr = resolveAddresses(cctorInstrs);
    const cctorText = renderInstrs(cctorInstrs, cctorLabelAddr, '    ');

    return (
```

Insert new code immediately before the `return (` line (keep the four lines above it unchanged):

```js
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

```

- [ ] **Step 3: Replace the final `return` with the full buildable listing**

Replace the existing final `return (...)` statement (currently lines 736-761):

```js
    return (
      '// ildasm-style disassembly emitted directly by HaikuScript — illustrative text\n' +
      '// only: not assembled into a real module, and not executed.\n' +
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
      '  } // end of method HaikuProgram::.cctor\n' +
      '} // end of class HaikuProgram\n'
    );
```

with:

```js
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
```

Also update `generateIl`'s leading doc comment (immediately above `function generateIl(ast, seed) {`, currently reading):

```js
  // PHASE 3b: Code Generation — turn the AST into an ildasm-style CIL
  // disassembly listing (text only: nothing is assembled into a real .dll,
  // and nothing here executes). Walks the exact same AST as generateWat via
  // a parallel walk()/emitCondition() pair, so the two backends are easy to
  // compare instruction-by-instruction. See
  // docs/superpowers/specs/2026-08-10-il-backend-design.md.
```

to:

```js
  // PHASE 3b: Code Generation — turn the AST into an ildasm-style CIL
  // listing that ilasm can actually assemble into a working .exe (see the
  // REPL's Build .exe button). Walks the exact same AST as generateWat via
  // a parallel walk()/emitCondition() pair, so the two backends are easy to
  // compare instruction-by-instruction. See
  // docs/superpowers/specs/2026-08-11-repl-syntax-compile-exe-design.md.
```

- [ ] **Step 4: Verify structurally with a Node script**

```bash
cd /mnt/c/Code/Fizzbash/haikuscript
cat > /tmp/il-buildable-check.js << 'EOF'
const { tokenize, parseProgram, generateIl } = require('./haiku-core');
const fs = require('fs');
const source = fs.readFileSync('src/guess_number.hk', 'utf8');
const ast = parseProgram(tokenize(source));
const il = generateIl(ast, 42);
console.log(il);

const required = [
  '.assembly extern mscorlib {}',
  '.assembly HaikuProgram',
  '.module HaikuProgram.exe',
  'class private auto ansi HaikuHost',
  'void Print(int32 v)',
  'int32 Input()',
  'void [mscorlib]System.Console::WriteLine(int32)',
  'string [mscorlib]System.Console::ReadLine()',
  'int32 [mscorlib]System.Int32::Parse(string)',
  '.entrypoint',
  'HaikuProgram::Compute()'
];
for (const needle of required) {
  if (!il.includes(needle)) throw new Error('missing required text: ' + needle);
}
console.log('OK: all required buildable-IL elements present');
EOF
node /tmp/il-buildable-check.js
rm /tmp/il-buildable-check.js
```

Expected: prints the full listing, then `OK: all required buildable-IL elements present`.

- [ ] **Step 5: Verify it actually assembles and runs with `ilasm`**

This is the step that matters most — it confirms the IL text is not just plausible-looking but genuinely buildable. Run (this repo is on a Windows filesystem reached via WSL, so `ilasm.exe` is invoked through the standard WSL→Windows interop path — see this project's own MSBuild/vstest notes for the same pattern):

```bash
cd /mnt/c/Code/Fizzbash/haikuscript
mkdir -p build/il-verify
cat > build/il-verify/gen.js << 'EOF'
const { tokenize, parseProgram, generateIl } = require('../../haiku-core');
const fs = require('fs');
const source = fs.readFileSync('../../src/fibonacci.hk', 'utf8');
const ast = parseProgram(tokenize(source));
fs.writeFileSync('fib.il', generateIl(ast, 42));
EOF
(cd build/il-verify && node gen.js)
WIN_IL=$(wslpath -w "$(pwd)/build/il-verify/fib.il")
WIN_EXE=$(wslpath -w "$(pwd)/build/il-verify/fib.exe")
"/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/ilasm.exe" "$WIN_IL" /exe "/output:$WIN_EXE"
cd build/il-verify
"/mnt/c/Windows/System32/cmd.exe" /c "$(wslpath -w "$(pwd)/fib.exe")"
cd /mnt/c/Code/Fizzbash/haikuscript
rm -rf build/il-verify
```

Expected: `ilasm.exe` prints `Operation completed successfully` and exits 0; running `fib.exe` prints `55` — the same value the WASM path produces for `src/fibonacci.hk`. If `ilasm.exe` isn't reachable at that exact path in your environment, search for it with `find /mnt/c/Windows -iname ilasm.exe 2>/dev/null` (it also exists under `Framework\v4.0.30319\` — the 32-bit sibling directory — as a fallback) and use whichever path resolves; if neither exists, report `BLOCKED` rather than skipping this verification, since it's the one check that actually proves the IL is buildable.

- [ ] **Step 6: Commit**

```bash
cd /mnt/c/Code/Fizzbash/haikuscript
git add haiku-core.js
git commit -m "Upgrade generateIl to real, ilasm-buildable IL (manifest, HaikuHost, entrypoint)"
```

---

### Task 4: `server.js` with a `/build-exe` route

**Files:**
- Create: `server.js`
- Modify: `package.json` (scripts + dependencies)
- Modify: `repl.bat`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure infrastructure).
- Produces: a running HTTP server on port 3000 (or `process.env.PORT`) that (a) serves static files from the repo root exactly like the `serve` package did, and (b) exposes `POST /build-exe` with body `{ "il": "<IL text>" }`, responding either `200` with an `application/octet-stream` body (the built `.exe`) or a non-`200` status with a JSON body `{ "error": "<message>" }`. Task 5 depends on this exact route shape.

- [ ] **Step 1: Create `server.js`**

Create `/mnt/c/Code/Fizzbash/haikuscript/server.js`:

```js
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

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/repl.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

function handleBuildExe(req, res) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let il;
    try { il = JSON.parse(body).il; } catch { il = null; }
    if (!il) {
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
}).listen(PORT, () => {
  console.log(`HaikuScript REPL server: http://localhost:${PORT}/repl.html`);
});
```

- [ ] **Step 2: Point `package.json` at the new server and drop the `serve` dependency**

Open `package.json`. It currently reads:

```json
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
```

Replace it with:

```json
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
```

- [ ] **Step 3: Update `repl.bat`**

Open `repl.bat`. It currently reads:

```bat
@echo off
REM Starts static server and opens browser REPL.
cd /d "%~dp0"
if not exist "node_modules\serve\build\main.js" (
    echo node_modules missing/broken for this OS. Run: npm install
    pause
    exit /b 1
)
start "" http://localhost:3000/repl.html
node node_modules\serve\build\main.js .
```

Replace it with:

```bat
@echo off
REM Starts the REPL server (static files + /build-exe route) and opens the browser.
cd /d "%~dp0"
start "" http://localhost:3000/repl.html
node server.js
```

- [ ] **Step 4: Verify static serving still works**

```bash
cd /mnt/c/Code/Fizzbash/haikuscript
node server.js &
SERVER_PID=$!
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/repl.html
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/haiku-core.js
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/GRAMMAR.md
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/does-not-exist.xyz
kill $SERVER_PID
```

Expected: `200`, `200`, `200`, `404`.

- [ ] **Step 5: Verify the `/build-exe` route end-to-end**

```bash
cd /mnt/c/Code/Fizzbash/haikuscript
node server.js &
SERVER_PID=$!
sleep 1

cat > /tmp/build-exe-check.js << 'EOF'
const { tokenize, parseProgram, generateIl } = require('/mnt/c/Code/Fizzbash/haikuscript/haiku-core');
const fs = require('fs');
const source = fs.readFileSync('/mnt/c/Code/Fizzbash/haikuscript/src/fibonacci.hk', 'utf8');
const il = generateIl(parseProgram(tokenize(source)), 42);

fetch('http://localhost:3000/build-exe', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ il })
}).then(async (resp) => {
  if (!resp.ok) {
    const body = await resp.json();
    throw new Error('build-exe failed: ' + body.error);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync('/tmp/build-exe-check.exe', buf);
  if (buf.length < 100) throw new Error('exe too small, got ' + buf.length + ' bytes');
  if (buf[0] !== 0x4D || buf[1] !== 0x5A) throw new Error('missing MZ header — not a valid PE file');
  console.log('OK: received a ' + buf.length + '-byte .exe with a valid MZ header');
});
EOF
node /tmp/build-exe-check.js
rm /tmp/build-exe-check.js

# Also confirm it actually runs and matches the WASM result:
WIN_EXE=$(wslpath -w /tmp/build-exe-check.exe)
"/mnt/c/Windows/System32/cmd.exe" /c "$WIN_EXE"

rm -f /tmp/build-exe-check.exe
kill $SERVER_PID
```

Expected: `OK: received a <N>-byte .exe with a valid MZ header`, then the executed `.exe` prints `55`. If `fetch` is unavailable in your Node version, check with `node -e "console.log(typeof fetch)"` first — this repo's `.nvmrc` pins Node 24 which has `fetch` built in, so it should be available; if not, report `BLOCKED` and note the Node version in use.

- [ ] **Step 6: Commit**

```bash
cd /mnt/c/Code/Fizzbash/haikuscript
git add server.js package.json package-lock.json repl.bat
git commit -m "Replace serve package with a zero-dependency server.js exposing POST /build-exe"
```

Note: if `npm install` hasn't been re-run to drop `serve` from `node_modules`/`package-lock.json` by the time you commit, run `npm install` first so `package-lock.json` reflects the dependency removal, then include the updated lockfile in this commit.

---

### Task 5: Build .exe button in the REPL

**Files:**
- Modify: `repl.html` (add a button inside the IL panel's `<summary>`)
- Modify: `repl.js` (enable/disable the button, `buildExe()` handler)

**Interfaces:**
- Consumes: `resetPanels()` and `compilePipeline()` (Task 2), the `/build-exe` route (Task 4), buildable IL from `HaikuCore.generateIl` (Task 3).
- Produces: nothing further — this is the last task.

- [ ] **Step 1: Add the button to the IL panel's summary**

Open `repl.html`. The IL panel currently reads:

```html
      <details>
        <summary>CIL / IL (ildasm-style)</summary>
        <pre id="il"></pre>
      </details>
```

Replace it with:

```html
      <details>
        <summary>CIL / IL (ildasm-style) <button id="buildExeBtn" disabled>Build .exe</button></summary>
        <pre id="il"></pre>
      </details>
```

- [ ] **Step 2: Disable the button whenever panels reset, enable it once IL exists**

Open `repl.js`. `resetPanels()` (added in Task 2) currently reads:

```js
  function resetPanels() {
    $('result').className = 'result';
    $('result').textContent = 'Running…';
    $('tokens').textContent = '';
    $('ast').textContent = '';
    $('wat').textContent = '';
    $('il').textContent = '';
    $('printed').textContent = '';
  }
```

Replace it with:

```js
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
```

Then, in `compilePipeline()` (also added in Task 2), the line that sets the IL panel currently reads:

```js
    const il = HaikuCore.generateIl(ast, seed);
    $('il').textContent = il;
```

Replace it with:

```js
    const il = HaikuCore.generateIl(ast, seed);
    $('il').textContent = il;
    $('buildExeBtn').disabled = false;
```

- [ ] **Step 3: Add the `buildExe()` handler**

Still in `repl.js`, immediately after the `compileOnly()` function (added in Task 2) and before the `// ---- File open / save ...` section comment, add:

```js

  // POSTs the currently-displayed IL to the server's /build-exe route
  // (server.js, which shells out to ilasm.exe) and downloads the result.
  async function buildExe() {
    const il = $('il').textContent;
    if (!il) return;
    setStatus('Building .exe…', 'busy');
    try {
      const resp = await fetch('/build-exe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ il })
      });
      if (!resp.ok) {
        const { error } = await resp.json();
        throw new Error(error);
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
    }
  }
```

- [ ] **Step 4: Wire the button's click handler**

In `init()`, the wiring block (extended in Task 2) currently reads:

```js
    $('runBtn').addEventListener('click', run);
    $('compileBtn').addEventListener('click', compileOnly);
    $('openBtn').addEventListener('click', openFile);
```

Replace it with:

```js
    $('runBtn').addEventListener('click', run);
    $('compileBtn').addEventListener('click', compileOnly);
    $('buildExeBtn').addEventListener('click', buildExe);
    $('openBtn').addEventListener('click', openFile);
```

- [ ] **Step 5: Verify with a Node simulation against the real server**

```bash
cd /mnt/c/Code/Fizzbash/haikuscript
node server.js &
SERVER_PID=$!
sleep 1

grep -n 'id="buildExeBtn"' repl.html
grep -n "async function buildExe" repl.js
grep -n "buildExeBtn.*disabled = false" repl.js
grep -n "buildExeBtn.*disabled = true" repl.js

cat > /tmp/full-flow-check.js << 'EOF'
const { tokenize, parseProgram, generateIl } = require('/mnt/c/Code/Fizzbash/haikuscript/haiku-core');
const fs = require('fs');
const source = fs.readFileSync('/mnt/c/Code/Fizzbash/haikuscript/src/guess_number.hk', 'utf8');
const il = generateIl(parseProgram(tokenize(source)), 7);

fetch('http://localhost:3000/build-exe', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ il })
}).then(async (resp) => {
  if (!resp.ok) throw new Error('build-exe failed: ' + (await resp.json()).error);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf[0] !== 0x4D || buf[1] !== 0x5A) throw new Error('not a valid PE file');
  console.log('OK: full pipeline (a program using random/input/print/loop) built a valid exe, ' + buf.length + ' bytes');
});
EOF
node /tmp/full-flow-check.js
rm /tmp/full-flow-check.js
kill $SERVER_PID
```

Expected: all four `grep` calls find a match; the script prints `OK: full pipeline (a program using random/input/print/loop) built a valid exe, <N> bytes`.

Note in your report that the button's enabled/disabled state transitions and the actual file-download behavior need a real browser to fully confirm — if you don't have one available, say so explicitly.

- [ ] **Step 6: Manual browser verification (do this step yourself if you have a browser; otherwise report it as unverified)**

```bash
cd /mnt/c/Code/Fizzbash/haikuscript
node server.js
```

In a browser, open `http://localhost:3000/repl.html` and confirm:
- **Build .exe** starts disabled (greyed out).
- Clicking **▶ Run** or **⚙ Compile** enables it.
- Clicking **⚙ Compile** on the default sample does NOT show any `window.prompt` dialogs and leaves **Printed Output** untouched; the Result panel shows `Compiled ✓ (not run)`.
- Clicking **Build .exe** downloads `HaikuProgram.exe`; running it from a Windows terminal (`.\HaikuProgram.exe`) prints the same value shown in the REPL's **Result** panel.
- The **Syntax Reference** panel (Task 1) still shows `GRAMMAR.md`'s content.

Stop the server (`Ctrl+C`) once confirmed.

- [ ] **Step 7: Commit**

```bash
cd /mnt/c/Code/Fizzbash/haikuscript
git add repl.html repl.js
git commit -m "Add Build .exe button to the IL panel"
```
