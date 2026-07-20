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
      const importObject = { env: { print: (v) => printed.push(v) } };
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