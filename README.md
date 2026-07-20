# HaikuScript Pipeline Deployment Manual

*Part of the HaikuScript docs: README (this file, how to build & run) · [GRAMMAR](GRAMMAR.md) (how to write the language) · [CODEBASE](CODEBASE.md) (full source).*

Follow these procedures to set up, test the lexer/parser, compile to WebAssembly, run the live REPL, and load the IDE diagnostic extension.

---

## 📋 Toolchain Requirements

This project uses the Node ecosystem, so there is no `requirements.txt`. The equivalent "pinned requirements" live in three places:

- **`package.json`** — declared dependency ranges (the requirements manifest).
- **`package-lock.json`** — exact resolved versions of every transitive dependency.
- **`.nvmrc`** — the pinned Node version.

### Verified build matrix

| Tool / package     | Pinned / range               | Verified version |
| ------------------ | ---------------------------- | ---------------- |
| Node.js            | `>=20` (`.nvmrc`: `24.15.0`) | `24.15.0`        |
| npm                | `>=10`                       | `11.12.1`        |
| wabt (dependency)  | `^1.0.36`                    | `1.0.39`         |
| serve (dependency) | `^14.2.1`                    | `14.2.6`         |

> **No build step.** The lexer is plain JavaScript (`haiku-core.js`), so nothing has to be compiled ahead of time — `npm install` is the whole setup. The grammar is trivial (a line is a run of letter-words), so we tokenize by hand. A Tree-sitter grammar (`grammar.js`) and `queries/highlights.scm` are kept as an **optional** way to get editor syntax highlighting; they are **not** needed to run. (For a bigger language you'd let Tree-sitter generate the parser — here it's overkill.)

> **This section is reference only — nothing to run here.** To set the project up, start at **Phase 1** below.
>
> - **First-time / fresh checkout** → `npm install` (Phase 1). Creates `node_modules` and `package-lock.json`.
> - **Later, exact reinstall from an existing lockfile** (CI, reproducible rebuild) → `npm ci`.

---

## 📦 Phase 1: Environment Assembly

**Start here.** Run this within your workspace directory (`C:\Code\Fizzbash\haikuscript`):

```powershell
# 0. Check Node. Need 20 or newer.
node -v
#   If missing / older than 20, install and select it (nvm-windows needs an
#   explicit version — it does NOT read .nvmrc):
#     nvm install 24.15.0
#     nvm use 24.15.0

# 1. Install dependencies (creates node_modules + package-lock.json)
npm install
```

That's the entire setup — there is no parser/grammar to build.

---

## 🧪 Phase 2: Diagnostic Validation Checks

Inspect how the hand-written lexer and the recursive parser process the poetry:

```powershell
# Check 1: Extract and audit structured vocabulary tokens
npm run tokens

# Check 2: Parse tokens into an abstract syntax tree (AST)
npm run ast
```

---

## 🚀 Phase 3: WebAssembly Code Generation & Execution

Compile the poem into browser-executable bytecode and serve it:

```powershell
# 1. Compile source logic directly into .wat and .wasm blocks
npm run compile

# 2. Boot up a local static server
npm run serve
```

### Browser Execution Verification

1. Open your web browser to the port the terminal prints (typically `http://localhost:3000`).
2. Press **F12** or right-click → **Inspect** to reveal the developer console.
3. Refresh the tab. The page renders the outcome on screen in a green result box — **`Result: 55`** — and also logs to the console:
   `[HaikuScript Result Processed]: 55`

---

## 🎡 Phase 3b: Interactive Browser REPL

The static server from Phase 3 also serves a full REPL that runs **every** stage live in the browser — no server-side step.

```powershell
# (Same server as Phase 3 — start it if it isn't already running)
npm run serve
```

Or double-click **`repl.bat`** — starts server and opens the REPL tab for you.

Then open **`http://localhost:3000/repl.html`**.

- **Edit on screen** — type HaikuScript into the editor and press **Run** (or **Ctrl + Enter**).
- The page runs the whole pipeline client-side: lex → syllable audit → AST → WAT → WASM → execute, showing the **Tokens**, **AST**, **WAT**, and final **Result** panels.
- **Errors** surface with the offending line number and highlight that line in the editor.
- **Open… / Save / Save As…** use the browser File System Access API (Chrome/Edge). On other browsers these fall back to a file picker + download automatically.

**Random numbers** are built into the compiler itself (a self-contained xorshift PRNG emitted into the WASM — no host randomness). Any of the `RANDOM` keywords — `dream` (1 syl), `random` / `something` (2 syl), or `imagine` / `randomly` (3 syl) — sets a variable to a random `0`–`99`; pick whichever fits the line's meter. Both the standalone verb form (`Something the x`) and the assignment form (`Set x to something`) work. Each compile bakes a fresh seed, so every Run gives a new number. Example (Result = a random 0–99):

```text
Set x to zero
Dream the x beautifully
Quietly it is
```

> How it works: `repl.html` loads the shared compiler core (`haiku-core.js`) plus the browser build of `wabt` straight from `node_modules/`. The CLI (`haiku.js`) and the REPL share the exact same core, so they can never disagree.

---

## 🎨 Phase 4: Side-loading the Live IDE Extension Sandbox

To activate live syntax checking inside VS Code, pass your absolute project path to the runtime instance:

```powershell
code --extensionDevelopmentPath="C:\Code\Fizzbash\haikuscript" fibonacci.hk
```

### Live Stage Gimmick Test Strategy

1. Look at the bottom-right bar of the new window. It will display **HaikuScript** as an explicitly recognized language mode.
2. Intentionally create a grammar violation on line 7 (e.g., change `Set z to the x` to `Set z to the x errorme`).
3. Press **Ctrl + S** to save the file.
4. The background compiler bridge (`node haiku.js --json-errors`) immediately awakens, audits your syllable structure, and casts a **red syntax error squiggly** right underneath your modified line!

---

## 📜 License

Licensed under the **[Hippocratic License 2.1](https://firstdonoharm.dev/version/2/1/)** — a recognised [Ethical Source](https://ethicalsource.dev) license. Broad permission to use, modify, and distribute the software, **conditioned on not using it in ways that violate human rights** (as defined by the UN Universal Declaration of Human Rights and the UN Global Compact). See [`LICENSE`](LICENSE) for the full text. (Ethical Source licenses are source-available rather than OSI-approved "open source".)
