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

  // ---- Theme ---------------------------------------------------------------
  // The <head> inline script already set data-theme before first paint (see
  // repl.html) — this just wires the toggle and keeps the icon in sync.
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('haikuscript-theme', theme); } catch (e) {}
    const btn = $('themeToggle');
    btn.textContent = theme === 'light' ? '🌙' : '☀️';
    btn.title = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  }

  // ---- Markdown -------------------------------------------------------------
  // Minimal GFM-ish renderer for the Syntax Reference tab (GRAMMAR.md), kept
  // dependency-free like the rest of this project. Covers what that one file
  // actually uses: headings, **bold**/*italic*, code spans, fenced code
  // blocks, links, (un)ordered lists, blockquotes, tables (with \| escaping
  // inside cells), and horizontal rules — not general-purpose Markdown.
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // "AT_AT_CS<index>AT_AT" marks where a code span was pulled out, so the
  // bold/italic/link passes below can't see (and mangle) its raw contents.
  // Built from plain ASCII with no backslash-escapes, so nothing here risks
  // being collapsed into a control character when this file is written out.
  const CODE_MARK = String.fromCharCode(64, 64) + 'CS'; // "@@CS"
  const CODE_MARK_END = String.fromCharCode(64, 64);    // "@@"

  function renderInline(text) {
    const codeSpans = [];
    text = text.split(CODE_MARK).join('').split(CODE_MARK_END).join('');
    text = text.replace(/`([^`]+)`/g, (_, code) => {
      codeSpans.push(escapeHtml(code));
      return CODE_MARK + (codeSpans.length - 1) + CODE_MARK_END;
    });
    text = escapeHtml(text);
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) =>
      `<a href="${href}" target="_blank" rel="noopener">${label}</a>`);
    text = text.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*([^*]+?)\*/g, '<em>$1</em>');
    const markRe = new RegExp(CODE_MARK + '(\\d+)' + CODE_MARK_END, 'g');
    text = text.replace(markRe, (_, i) => `<code>${codeSpans[Number(i)]}</code>`);
    return text;
  }

  // Splits a `| a | b |` row into raw cell strings, honoring `\|` as an
  // escaped literal pipe (GRAMMAR.md's pattern table uses this inside code
  // spans, e.g. `` `(loop until\|until)` ``) rather than a cell boundary.
  function splitTableRow(line) {
    let row = line.trim();
    if (row.startsWith('|')) row = row.slice(1);
    if (row.endsWith('|')) row = row.slice(0, -1);
    return row.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
  }

  function isTableSeparator(line) {
    return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-');
  }

  function renderMarkdown(md) {
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) { i++; continue; }

      // Fenced code block.
      if (/^```/.test(line)) {
        const body = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { body.push(lines[i]); i++; }
        i++; // skip closing fence
        html += `<pre><code>${escapeHtml(body.join('\n'))}</code></pre>\n`;
        continue;
      }

      // Heading.
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        html += `<h${level}>${renderInline(heading[2])}</h${level}>\n`;
        i++;
        continue;
      }

      // Horizontal rule.
      if (/^(---+|\*\*\*+)\s*$/.test(line)) { html += '<hr>\n'; i++; continue; }

      // Table (header row + a following separator row of dashes/colons/pipes).
      if (line.trim().startsWith('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        const header = splitTableRow(line);
        i += 2; // header + separator
        const bodyRows = [];
        while (i < lines.length && lines[i].trim().startsWith('|')) { bodyRows.push(splitTableRow(lines[i])); i++; }
        html += '<div class="md-table-wrap"><table><thead><tr>' +
          header.map(c => `<th>${renderInline(c)}</th>`).join('') + '</tr></thead><tbody>' +
          bodyRows.map(r => '<tr>' + r.map(c => `<td>${renderInline(c)}</td>`).join('') + '</tr>').join('') +
          '</tbody></table></div>\n';
        continue;
      }

      // Blockquote — consume consecutive `>` lines as one soft-wrapped block.
      if (/^>\s?/.test(line)) {
        const body = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { body.push(lines[i].replace(/^>\s?/, '')); i++; }
        html += `<blockquote><p>${renderInline(body.join(' '))}</p></blockquote>\n`;
        continue;
      }

      // Unordered / ordered list — a run of items, each possibly spanning
      // soft-wrapped continuation lines with no marker of its own.
      const ulItem = line.match(/^\s*[-*+]\s+(.*)$/);
      const olItem = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ulItem || olItem) {
        const ordered = !!olItem;
        const itemRe = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(itemRe);
          if (m) {
            items.push(m[1]);
          } else if (lines[i].trim() && !isTableSeparator(lines[i])) {
            items[items.length - 1] += ' ' + lines[i].trim();
          } else {
            break;
          }
          i++;
        }
        const tag = ordered ? 'ol' : 'ul';
        html += `<${tag}>` + items.map(it => `<li>${renderInline(it)}</li>`).join('') + `</${tag}>\n`;
        continue;
      }

      // Paragraph — soft-wrapped lines until a blank line or a new block.
      const para = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|[-*+]\s|\d+\.\s|---+\s*$|\*\*\*+\s*$)/.test(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      html += `<p>${renderInline(para.join(' '))}</p>\n`;
    }

    return html;
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
      if (t) $('grammar').innerHTML = renderMarkdown(t);
    }).catch(() => {});

    $('tabBtnRepl').addEventListener('click', () => switchTab('repl'));
    $('tabBtnGrammar').addEventListener('click', () => switchTab('grammar'));
    $('themeToggle').addEventListener('click', toggleTheme);
    applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');

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
