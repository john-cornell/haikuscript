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