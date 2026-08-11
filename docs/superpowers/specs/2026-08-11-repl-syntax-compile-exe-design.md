# REPL Syntax Tab, Compile Button, and .exe Build — Design

## Purpose

Three additions to the REPL, building on the IL backend shipped in
[2026-08-10-il-backend-design.md](2026-08-10-il-backend-design.md):

1. A **Syntax Reference** panel so the grammar is visible without leaving the
   REPL.
2. A **Compile** button that runs the full codegen pipeline (including a real
   WASM assemble step) without executing the program — useful for inspecting
   Tokens/AST/WAT/IL without triggering `input()` prompts or side effects.
3. A **Build .exe** button that turns the CIL panel from illustrative-only
   text into a genuinely assemblable program, and adds a server-side route
   that shells out to `ilasm.exe` to produce a real, downloadable `.exe`.

Feature 3 is the one substantive scope change from the IL backend's original
design: that spec explicitly scoped `generateIl` as "textual-emission-only...
nothing is assembled into an actual `.dll`". This spec supersedes that
constraint — `generateIl`'s output becomes real, buildable IL — while keeping
everything else about the IL panel (its shape, its role as a second backend
over the same AST, its display in the REPL) unchanged.

## Scope

- `repl.html` / `repl.js`: new Syntax panel, new Compile button, new "Build
  .exe" control on the IL panel.
- `haiku-core.js`: `generateIl` upgraded to emit a complete, `ilasm`-buildable
  program (assembly manifest, entry point, real `HaikuHost` implementation).
- New `server.js`: replaces the `serve` package for `npm run serve`/`repl.bat`
  with a zero-dependency static file server plus one `POST /build-exe` route.
- No changes to `generateWat`, the tokenizer, or the parser.
- No automated tests added (consistent with the rest of the REPL/codegen —
  see Testing below).

## 1. Syntax Reference panel

`repl.html` gains one more `<details>` block, in the same right-column list
as Tokens/AST/WAT/IL, placed last:

```html
<details>
  <summary>Syntax Reference (GRAMMAR.md)</summary>
  <pre id="grammar"></pre>
</details>
```

`repl.js`'s `init()` fetches it once, alongside the existing
`fetch('/src/fibonacci.hk')` call:

```js
fetch('/GRAMMAR.md').then(r => r.ok ? r.text() : null).then(t => {
  if (t) $('grammar').textContent = t;
}).catch(() => {});
```

Plain text in a `<pre>`, matching every other panel — no markdown rendering,
no new dependency. Static: populated once at page load, not re-fetched on
Run/Compile.

## 2. Compile button

**Pipeline refactor.** `repl.js`'s `run()` currently does the whole pipeline
inline. Split the shared prefix into a `compilePipeline()` helper that both
`run()` and the new `compileOnly()` call:

```js
// Returns { ast, wat, il, wasmBuffer } or throws (same error shape run() already catches).
async function compilePipeline() {
  await ensureToolchain();
  const source = editor.value;

  const tokens = HaikuCore.tokenize(source);
  $('tokens').textContent = JSON.stringify(tokens, null, 2);

  const ast = HaikuCore.parseProgram(tokens);
  $('ast').textContent = JSON.stringify(ast, null, 2);

  const seed = Date.now();
  const wat = HaikuCore.generateWat(ast, seed);
  $('wat').textContent = wat;
  const il = HaikuCore.generateIl(ast, seed);
  $('il').textContent = il;

  const module = wabt.parseWat('repl.wat', wat);
  const { buffer } = module.toBinary({});

  return { ast, wat, il, wasmBuffer: buffer };
}
```

`run()` becomes:

```js
async function run() {
  resetPanels(); // extracted from the current top-of-run() reset block
  try {
    setStatus('Phase 1-3 — compiling…', 'busy');
    const { wasmBuffer } = await compilePipeline();

    setStatus('Phase 4 — executing…', 'busy');
    const printed = [];
    const readInput = () => { /* unchanged */ };
    const importObject = { env: { print: (v) => printed.push(v), input: readInput } };
    const { instance } = await WebAssembly.instantiate(wasmBuffer, importObject);

    const value = instance.exports.compute();
    $('printed').textContent = printed.length ? printed.join('\n') : '(none)';
    $('result').textContent = 'Result: ' + value;
    $('result').className = 'result ok';
    setStatus('Done ✓', 'ok');
  } catch (err) {
    reportError(err); // extracted from the current catch block
  }
}
```

`compileOnly()` is new:

```js
async function compileOnly() {
  resetPanels();
  try {
    setStatus('Compiling…', 'busy');
    await compilePipeline();
    $('result').textContent = 'Compiled ✓ (not run)';
    $('result').className = 'result ok';
    setStatus('Compiled ✓', 'ok');
  } catch (err) {
    reportError(err);
  }
}
```

`resetPanels()` and `reportError(err)` are extracted verbatim from `run()`'s
current reset block and `catch` block respectively — no behavior change,
just named so both entry points can call them. `compileOnly()` does not touch
`$('printed')` — it is left however the previous Run/Compile left it (blank
on first load).

**Wiring.** `repl.html` gets one more toolbar button:

```html
<button id="compileBtn" title="Ctrl+Shift+Enter">⚙ Compile</button>
```

placed right after `runBtn`. `repl.js`'s `init()` wires it:

```js
$('compileBtn').addEventListener('click', compileOnly);
```

and the existing keydown handler gains one more branch:

```js
if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Enter') { e.preventDefault(); compileOnly(); }
```

**Error handling.** Identical to Run today — a parse/syllable/assemble error
throws from inside `compilePipeline()`, is caught by `compileOnly()`'s
`catch`, and surfaces via the same `reportError()` (line highlight + red
result box) that Run uses. Compile cannot fail during "execution" because it
never executes.

## 3. Build .exe

### 3a. `generateIl` becomes buildable

The IL text gains three things it currently lacks, all appended/wrapped
around the existing per-AST codegen (`Compute()`, `NextRandom()`, `.cctor`,
locals — all unchanged):

**Assembly manifest**, prepended before the `HaikuProgram` class:

```
.assembly extern mscorlib {}
.assembly HaikuProgram
{
  .ver 1:0:0:0
}
.module HaikuProgram.exe
```

**A real `HaikuHost` class**, replacing the current undefined
`HaikuHost::Print`/`HaikuHost::Input` call targets with an actual
implementation backed by `System.Console`:

```
.class private auto ansi HaikuHost
       extends [mscorlib]System.Object
{
  .method public hidebysig static void Print(int32 v) cil managed
  {
    .maxstack 8
    IL_0000: ldarg.0
    IL_0001: call void [mscorlib]System.Console::WriteLine(int32)
    IL_0006: ret
  } // end of method HaikuHost::Print

  .method public hidebysig static int32 Input() cil managed
  {
    .maxstack 8
    .locals init ([0] string s)
    IL_0000: call string [mscorlib]System.Console::ReadLine()
    IL_0005: stloc.0
    IL_0006: ldloc.0
    IL_0007: call int32 [mscorlib]System.Int32::Parse(string)
    IL_000c: ret
  } // end of method HaikuHost::Input
}
```

(`Print`/`Input`'s call sites inside `Compute()`'s `walk()` output — already
`call void HaikuHost::Print(int32)` / `call int32 HaikuHost::Input()` per the
original design's mapping table — are unchanged; they now resolve to a real
method instead of a placeholder.)

**An entry point**, added as a new method on the existing `HaikuProgram`
class:

```
.method public hidebysig static void Main() cil managed
{
  .entrypoint
  .maxstack 8
  IL_0000: call int32 HaikuProgram::Compute()
  IL_0005: call void [mscorlib]System.Console::WriteLine(int32)
  IL_000a: ret
} // end of method HaikuProgram::Main
```

`Main` does not print the program's `Print`-statement output through any new
mechanism — those already go through `HaikuHost::Print` inline during
`Compute()`'s execution, matching how the WASM path's `print` import behaves
during `run()`. `Main` only prints the final `Compute()` return value, mirroring
the REPL's `Result: <value>` line.

Byte-address (`IL_XXXX:`) computation for `HaikuHost`'s and `Main`'s
instructions uses the exact same `resolveAddresses`/`renderInstrs`/
`OPCODE_SIZE` machinery already built for `Compute()`/`NextRandom()` — each
method's addresses restart at `IL_0000` independently, matching real ildasm
output (addresses are per-method, not whole-file).

### 3b. UI

The IL panel's `<summary>` gains an inline button:

```html
<details>
  <summary>CIL / IL (ildasm-style) <button id="buildExeBtn" disabled>Build .exe</button></summary>
  <pre id="il"></pre>
</details>
```

`repl.js`:

```js
$('buildExeBtn').addEventListener('click', buildExe);
```

`buildExeBtn` starts `disabled` and is enabled whenever `$('il').textContent`
is non-empty — i.e. right after `compilePipeline()` sets it, in both `run()`
and `compileOnly()`. `resetPanels()` (called at the top of both) disables it
again alongside clearing `$('il').textContent`.

```js
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

### 3c. Server

`serve` (a static-file-only package) is replaced by a new `server.js` at the
repo root — zero new npm dependencies, using only Node's `http`, `fs`, `path`,
and `child_process` built-ins:

```js
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
  '.wasm': 'application/wasm'
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
    if (!il) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing "il" in request body' })); }

    const id = crypto.randomBytes(6).toString('hex');
    const tmpDir = os.tmpdir();
    const ilPath = path.join(tmpDir, `haiku-${id}.il`);
    const exePath = path.join(tmpDir, `haiku-${id}.exe`);

    fs.writeFile(ilPath, il, (writeErr) => {
      if (writeErr) { res.writeHead(500); return res.end(JSON.stringify({ error: writeErr.message })); }

      execFile(ILASM_PATH, [ilPath, '/exe', `/output:${exePath}`], (ilasmErr, stdout, stderr) => {
        fs.unlink(ilPath, () => {});
        if (ilasmErr) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: stderr || stdout || ilasmErr.message }));
        }
        fs.readFile(exePath, (readErr, exeData) => {
          fs.unlink(exePath, () => {});
          if (readErr) { res.writeHead(500); return res.end(JSON.stringify({ error: readErr.message })); }
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

`package.json`:

```json
"scripts": {
  "serve": "node server.js",
  "repl": "node server.js"
}
```

(the `serve` npm *dependency* is removed from `package.json`'s
`dependencies` — nothing else references it).

`repl.bat`:

```bat
@echo off
REM Starts static server (with /build-exe route) and opens browser REPL.
cd /d "%~dp0"
start "" http://localhost:3000/repl.html
node server.js
```

(the `node_modules\serve\build\main.js` existence check is dropped along
with the dependency it checked for).

**Why `os.tmpdir()`, not a repo `build/` path:** `server.js` runs directly on
Windows (per README, all commands are PowerShell/`.bat`), so `os.tmpdir()`
resolves to a normal Windows temp directory — no WSL path translation is
needed anywhere in this flow, unlike the MSBuild/vstest interop notes
elsewhere in this project.

## Error handling

- **Compile-time errors** (parse/syllable/assemble failures): identical path
  to Run today — caught, reported via `reportError()`, line highlighted.
- **ilasm failures** (malformed IL — shouldn't happen given `generateIl`
  always emits valid output, but genuinely possible if e.g. `ilasm.exe` is
  missing or a future codegen change introduces a bug): the server returns
  HTTP 500 with `{ error: <ilasm's stderr> }`; `buildExe()` surfaces that
  string directly in the status bar so the raw `ilasm` diagnostic is visible,
  not swallowed.
- **Missing `ilasm.exe`:** `execFile` fails with `ENOENT`; `ilasmErr.message`
  (Node's own "spawn ENOENT" text) is returned the same way, which is enough
  to point at a missing/misconfigured `ILASM_PATH`.

## Testing

Manual verification only, consistent with the rest of the REPL/codegen work:

- **Syntax panel:** open the REPL, confirm the panel shows the same text as
  `GRAMMAR.md`.
- **Compile:** run Compile against a program with an `input()` call and
  confirm no `window.prompt` fires and Tokens/AST/WAT/IL populate; run
  Compile against a program with a syllable error and confirm the same error
  path as Run today.
- **Build .exe:** Compile (or Run) `src/fibonacci.hk`, click Build .exe,
  confirm a `HaikuProgram.exe` downloads and running it from a Windows
  terminal (`.\HaikuProgram.exe`) prints `55`. Repeat with a program using
  `print` and one using `input` to confirm `HaikuHost::Print`/`Input` work
  against a real console.
- No automated test suite is added, matching `generateWat`/`generateIl`'s
  existing testing approach.
