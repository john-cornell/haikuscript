const fs = require('fs');
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
    const importObject = { env: { print: (v) => console.log('Print:', v) } };
    const { instance } = await WebAssembly.instantiate(buffer, importObject);
    console.log('Result:', instance.exports.compute());
    process.exit(0);
  }

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