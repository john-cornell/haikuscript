# IL (CIL) Backend for the REPL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `generateIl(ast, seed)` code generator to `haiku-core.js` that emits an ildasm-style CIL disassembly listing from the same AST `generateWat` consumes, and show it in a new REPL panel alongside the existing WAT panel on every Run.

**Architecture:** `generateIl` builds an in-memory instruction list (op + optional arg/comment, plus label markers) via a `walk()`/`emitCondition()` pair that mirrors `generateWat`'s structure one-for-one, then a byte-size pass assigns every instruction a fixed size (always using short branch forms) so `IL_XXXX` addresses and branch targets can be resolved in a single linear pass — no real assembler, no real .NET involved. The REPL calls it right after `generateWat` on the same seed and renders the text into a new panel; nothing about execution changes.

**Tech Stack:** Plain JavaScript (same as the rest of `haiku-core.js`/`repl.js`), no new npm dependencies.

## Global Constraints

- No new npm dependencies — this is pure text generation in JS.
- No changes to `tokenize`, `parseProgram`, the AST node shapes, or the WASM execution path in `repl.js`.
- The IL output is display-only: nothing is assembled into a real `.dll`, nothing executes .NET IL. Only the existing WASM path still runs the program.
- No target toggle / no new button — `generateIl` runs on every existing **Run** click, alongside `generateWat`, per the approved design (`docs/superpowers/specs/2026-08-10-il-backend-design.md`).
- No automated test suite exists in this repo today (no jest/mocha, no `test` npm script) and the spec explicitly scopes testing to manual/script-based verification — don't add a test framework as part of this work.
- Both backends must receive the **same seed value** per Run (`Date.now()` captured once), so their PRNG listings are directly comparable.

---

### Task 1: `generateIl` core — locals, simple statements, address/rendering infrastructure

**Files:**
- Modify: `haiku-core.js` (add `generateIl` after `generateWat`, which currently ends at line 540; update the module's `return { ... }` on line 542)

**Interfaces:**
- Consumes: `collectIdentifiers(node, names)` (existing, line 407) — used exactly as `generateWat` uses it.
- Produces: `generateIl(ast, seed)` returning a string — the ildasm-style listing. At the end of this task it contains only a `.class`/`Compute()` shell (no `NextRandom`/`.cctor`/rng field yet — those arrive in Task 3). Internal helpers `ldc`, `ldlocSlot`/`stlocSlot`, `ldloc`/`stloc`, `pushOperand`, `resolveAddresses`, `renderInstrs`, `hex4` are scoped inside `generateIl` and not used by later tasks outside this function.

- [ ] **Step 1: Add the function skeleton with locals + simple-statement codegen + rendering plumbing**

Open `haiku-core.js`. Immediately after the closing `}` of `generateWat` (the line reading `  }` right before line 542's `return { VOCAB, ...`), insert:

```js
  // PHASE 3b: Code Generation — turn the AST into an ildasm-style CIL
  // disassembly listing (text only: nothing is assembled into a real .dll,
  // and nothing here executes). Walks the exact same AST as generateWat via
  // a parallel walk()/emitCondition() pair, so the two backends are easy to
  // compare instruction-by-instruction. See
  // docs/superpowers/specs/2026-08-10-il-backend-design.md.
  function generateIl(ast, seed) {
    const RNG_SEED = ((seed >>> 0) || 0x9E3779B9);
    const RNG_SEED_SIGNED = RNG_SEED > 0x7FFFFFFF ? RNG_SEED - 0x100000000 : RNG_SEED;

    const localNames = new Set(['x']); // Compute() always returns x
    ast.body.forEach(n => collectIdentifiers(n, localNames));
    const localList = Array.from(localNames);
    const localIndex = new Map(localList.map((name, i) => [name, i]));

    let nextLabel = 0;
    function newLabel() { return `L${nextLabel++}`; }

    function ldc(instrs, value) {
      if (value === -1) instrs.push({ op: 'ldc.i4.m1' });
      else if (value >= 0 && value <= 8) instrs.push({ op: `ldc.i4.${value}` });
      else if (value >= -128 && value <= 127) instrs.push({ op: 'ldc.i4.s', arg: value });
      else instrs.push({ op: 'ldc.i4', arg: value });
    }
    function ldlocSlot(instrs, slot, comment) {
      if (slot <= 3) instrs.push({ op: `ldloc.${slot}`, comment });
      else instrs.push({ op: 'ldloc.s', arg: slot, comment });
    }
    function stlocSlot(instrs, slot, comment) {
      if (slot <= 3) instrs.push({ op: `stloc.${slot}`, comment });
      else instrs.push({ op: 'stloc.s', arg: slot, comment });
    }
    function ldloc(instrs, name) { ldlocSlot(instrs, localIndex.get(name), name); }
    function stloc(instrs, name) { stlocSlot(instrs, localIndex.get(name), name); }
    function pushOperand(instrs, operand) {
      if (typeof operand === 'number') ldc(instrs, operand);
      else ldloc(instrs, operand);
    }

    function walk(instrs, node) {
      if (!node) return;
      if (node.type === 'AssignmentStatement') {
        pushOperand(instrs, node.value);
        stloc(instrs, node.target);
        return;
      }
      if (node.type === 'AdditionStatement') {
        ldloc(instrs, node.target);
        pushOperand(instrs, node.source);
        instrs.push({ op: 'add' });
        stloc(instrs, node.target);
        return;
      }
    }

    const bodyInstrs = [];
    ast.body.forEach(n => walk(bodyInstrs, n));
    ldloc(bodyInstrs, 'x');
    bodyInstrs.push({ op: 'ret' });

    // ---- Byte-size + address resolution ----------------------------------
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

    function resolveAddresses(instrs) {
      const labelAddr = new Map();
      let addr = 0;
      instrs.forEach(instr => {
        if (instr.label !== undefined) { labelAddr.set(instr.label, addr); return; }
        instr.addr = addr;
        addr += OPCODE_SIZE[instr.op];
      });
      return labelAddr;
    }

    function hex4(n) { return 'IL_' + n.toString(16).padStart(4, '0'); }

    const BRANCH_OPS = new Set(['br.s', 'brfalse.s', 'brtrue.s']);
    function renderInstrs(instrs, labelAddr, indent) {
      let out = '';
      instrs.forEach(instr => {
        if (instr.label !== undefined) return;
        let line = `${indent}${hex4(instr.addr)}: ${instr.op}`;
        if (BRANCH_OPS.has(instr.op)) line += ` ${hex4(labelAddr.get(instr.arg))}`;
        else if (instr.arg !== undefined) line += ` ${instr.arg}`;
        if (instr.comment) line += ` // ${instr.comment}`;
        out += line + '\n';
      });
      return out;
    }

    const bodyLabelAddr = resolveAddresses(bodyInstrs);
    const bodyText = renderInstrs(bodyInstrs, bodyLabelAddr, '    ');
    const localsDecl = localList.map((name, i) => `        [${i}] int32 ${name}`).join(',\n');

    return (
      '// ildasm-style disassembly emitted directly by HaikuScript — illustrative text\n' +
      '// only: not assembled into a real module, and not executed.\n' +
      '.class private auto ansi HaikuProgram\n' +
      '       extends [mscorlib]System.Object\n' +
      '{\n' +
      '  .method public hidebysig static int32 Compute() cil managed\n' +
      '  {\n' +
      '    .maxstack 8\n' +
      '    .locals init (\n' + localsDecl + '\n    )\n\n' +
      bodyText +
      '  } // end of method HaikuProgram::Compute\n\n' +
      '} // end of class HaikuProgram\n'
    );
  }

```

Then update the module's export line (currently `return { VOCAB, EXPECTED_METER, HaikuError, tokenize, parseProgram, generateWat };`) to:

```js
  return { VOCAB, EXPECTED_METER, HaikuError, tokenize, parseProgram, generateWat, generateIl };
```

- [ ] **Step 2: Verify it fails before this exists**

This step is retroactive (you already wrote the code in Step 1) — instead, sanity-check by temporarily commenting out `generateIl` from the export line, running Step 3's check below, and confirming it throws `TypeError: generateIl is not a function`. Then restore the export line.

- [ ] **Step 3: Run a verification script against a hand-built AST**

Run:

```bash
cat > /tmp/il-check-1.js << 'EOF'
const { generateIl } = require('/mnt/c/Code/Fizzbash/haikuscript/haiku-core');
const ast = { type: 'Program', body: [
  { type: 'AssignmentStatement', target: 'x', value: 0 },
  { type: 'AssignmentStatement', target: 'y', value: 5 },
  { type: 'AdditionStatement', source: 'y', target: 'x' }
]};
const il = generateIl(ast, 42);
console.log(il);
if (!il.includes('ldc.i4.0')) throw new Error('expected ldc.i4.0 for value 0');
if (!il.includes('stloc.0')) throw new Error('expected stloc.0 for x (slot 0)');
if (!il.includes('ldc.i4.5')) throw new Error('expected ldc.i4.5 for value 5');
if (!il.includes(' add')) throw new Error('expected add opcode');
if (!il.includes(' ret')) throw new Error('expected ret opcode');
console.log('OK');
EOF
node /tmp/il-check-1.js
rm /tmp/il-check-1.js
```

Expected: prints the generated `.class HaikuProgram { ... Compute() ... }` listing, then `OK`. If any `throw` fires instead, the printed IL text tells you which opcode is missing/misnamed — fix `generateIl` and re-run.

- [ ] **Step 4: Commit**

```bash
cd /mnt/c/Code/Fizzbash/haikuscript
git add haiku-core.js
git commit -m "Add generateIl core: locals, assign/add codegen, address/rendering plumbing"
```

---

### Task 2: Conditions, `if`/`else`, and `while`/`until` loops

**Files:**
- Modify: `haiku-core.js` (extend `generateIl`'s `walk()` and add `emitCondition()`, both added in Task 1)

**Interfaces:**
- Consumes: `ldc`, `ldloc`/`stloc`, `pushOperand`, `newLabel` from Task 1's `generateIl` scope.
- Produces: `walk()` now also handles `WhileLoopStatement` and `IfStatement`; a new `emitCondition(instrs, terms)` helper other tasks don't need directly (Task 3 doesn't touch conditions).

- [ ] **Step 1: Add `emitCondition` and extend `walk()`**

Inside `generateIl` (added in Task 1), immediately before the `function walk(instrs, node) {` line, add:

```js
    const REL_OP = { eq: 'ceq', lt: 'clt', gt: 'cgt' };
    const JOIN_OP = { and: 'and', or: 'or', xor: 'xor' };

    // Mirrors generateWat's emitCondition: flat and/or/xor chain, left to
    // right, no precedence — leaves a single 0/1 on the stack.
    function emitCondition(instrs, terms) {
      terms.forEach((term, i) => {
        pushOperand(instrs, term.left);
        pushOperand(instrs, term.right);
        instrs.push({ op: REL_OP[term.op] });
        if (term.negate) { ldc(instrs, 0); instrs.push({ op: 'ceq' }); }
        if (i > 0) instrs.push({ op: JOIN_OP[term.join] });
      });
    }

```

Then, inside `walk()`, immediately before its closing `}` (right after the `AdditionStatement` block's `return;`), add:

```js
      if (node.type === 'WhileLoopStatement') {
        const start = newLabel();
        const end = newLabel();
        instrs.push({ label: start });
        emitCondition(instrs, node.condition.terms);
        if (node.condition.invert) { ldc(instrs, 0); instrs.push({ op: 'ceq' }); }
        instrs.push({ op: 'brtrue.s', arg: end });
        node.body.forEach(c => walk(instrs, c));
        instrs.push({ op: 'br.s', arg: start });
        instrs.push({ label: end });
        return;
      }
      if (node.type === 'IfStatement') {
        const hasElse = node.elseBody.length > 0;
        const elseLabel = hasElse ? newLabel() : null;
        const endLabel = newLabel();
        emitCondition(instrs, node.condition.terms);
        instrs.push({ op: 'brfalse.s', arg: hasElse ? elseLabel : endLabel });
        node.thenBody.forEach(c => walk(instrs, c));
        if (hasElse) {
          instrs.push({ op: 'br.s', arg: endLabel });
          instrs.push({ label: elseLabel });
          node.elseBody.forEach(c => walk(instrs, c));
        }
        instrs.push({ label: endLabel });
        return;
      }
```

> Note on `brtrue.s` vs `brfalse.s` for the loop: `generateWat`'s loop always breaks when the (possibly-inverted) condition is **true** (`br_if 1`) — `until` breaks once its raw condition becomes true, `while` negates once first so the same "break on true" branch works for opposite polarity. `brtrue.s` is the direct CIL equivalent of that `br_if`; using `brfalse.s` here would invert the loop's exit condition and is a bug — don't substitute it.

- [ ] **Step 2: Run a verification script exercising nested if/else inside a loop**

```bash
cat > /tmp/il-check-2.js << 'EOF'
const { generateIl } = require('/mnt/c/Code/Fizzbash/haikuscript/haiku-core');
const ast = { type: 'Program', body: [
  { type: 'AssignmentStatement', target: 'x', value: 0 },
  { type: 'AssignmentStatement', target: 'count', value: 0 },
  { type: 'WhileLoopStatement',
    condition: { terms: [ { negate: false, left: 'count', op: 'eq', right: 5 } ], invert: false },
    body: [
      { type: 'IfStatement',
        condition: { terms: [ { negate: false, left: 'count', op: 'eq', right: 2 } ] },
        thenBody: [ { type: 'AssignmentStatement', target: 'x', value: 99 } ],
        elseBody: [ { type: 'AdditionStatement', source: 1, target: 'x' } ]
      },
      { type: 'AdditionStatement', source: 1, target: 'count' }
    ]
  }
]};
const il = generateIl(ast, 42);
console.log(il);

const branchTargets = [...il.matchAll(/(?:br\.s|brtrue\.s|brfalse\.s) (IL_[0-9a-f]{4})/g)].map(m => m[1]);
const definedAddrs = new Set([...il.matchAll(/(IL_[0-9a-f]{4}):/g)].map(m => m[1]));
if (branchTargets.length === 0) throw new Error('expected at least one branch instruction');
for (const t of branchTargets) {
  if (!definedAddrs.has(t)) throw new Error('dangling branch target ' + t + ' — no instruction at that address');
}
if (!il.includes('brtrue.s')) throw new Error('expected the loop exit to use brtrue.s');
if (!il.includes('brfalse.s')) throw new Error('expected the if to use brfalse.s');
console.log('OK, ' + branchTargets.length + ' branch targets all resolved');
EOF
node /tmp/il-check-2.js
rm /tmp/il-check-2.js
```

Expected: prints the IL listing, then `OK, N branch targets all resolved`. If a `dangling branch target` error fires, the address math in `resolveAddresses`/`OPCODE_SIZE` (Task 1) disagrees with what `walk`/`emitCondition` emitted — check that every opcode you push has a matching `OPCODE_SIZE` entry.

- [ ] **Step 3: Commit**

```bash
cd /mnt/c/Code/Fizzbash/haikuscript
git add haiku-core.js
git commit -m "Add if/else and while/until codegen to generateIl"
```

---

### Task 3: Print, input, random (with PRNG parity), and the full class wrapper

**Files:**
- Modify: `haiku-core.js` (extend `generateIl`'s `walk()`, add the `NextRandom()`/`.cctor` instruction lists, replace the Task 1 minimal `return` with the full listing)

**Interfaces:**
- Consumes: `ldc`, `ldlocSlot`/`stlocSlot`, `resolveAddresses`, `renderInstrs` from Task 1.
- Produces: `generateIl`'s final return value — the complete `.class HaikuProgram { .field rng; NextRandom(); Compute(); .cctor(); }` text. No later task depends on any new named export from this task.

- [ ] **Step 1: Extend `walk()` with Print/Input/Random**

Inside `walk()`, immediately after the `AdditionStatement` block's `return;` and before the `WhileLoopStatement` block added in Task 2, add:

```js
      if (node.type === 'RandomStatement') {
        instrs.push({ op: 'call', arg: 'int32 HaikuProgram::NextRandom()' });
        stloc(instrs, node.target);
        return;
      }
      if (node.type === 'PrintStatement') {
        pushOperand(instrs, node.value);
        instrs.push({ op: 'call', arg: 'void HaikuHost::Print(int32)' });
        return;
      }
      if (node.type === 'InputStatement') {
        instrs.push({ op: 'call', arg: 'int32 HaikuHost::Input()' });
        stloc(instrs, node.target);
        return;
      }
```

- [ ] **Step 2: Add the `NextRandom()` and `.cctor` instruction lists**

Immediately after the line `const localsDecl = localList.map(...)` (added in Task 1, right before the `return (` statement), add:

```js
    // ---- NextRandom() — same xorshift32 algorithm as generateWat's
    // $next_random, translated instruction-for-instruction into CIL. --------
    const rngInstrs = [];
    rngInstrs.push({ op: 'ldsfld', arg: 'int32 HaikuProgram::rng' });
    stlocSlot(rngInstrs, 0, 's');
    ldlocSlot(rngInstrs, 0, 's'); ldlocSlot(rngInstrs, 0, 's'); ldc(rngInstrs, 13);
    rngInstrs.push({ op: 'shl' }); rngInstrs.push({ op: 'xor' }); stlocSlot(rngInstrs, 0, 's');
    ldlocSlot(rngInstrs, 0, 's'); ldlocSlot(rngInstrs, 0, 's'); ldc(rngInstrs, 17);
    rngInstrs.push({ op: 'shr.un' }); rngInstrs.push({ op: 'xor' }); stlocSlot(rngInstrs, 0, 's');
    ldlocSlot(rngInstrs, 0, 's'); ldlocSlot(rngInstrs, 0, 's'); ldc(rngInstrs, 5);
    rngInstrs.push({ op: 'shl' }); rngInstrs.push({ op: 'xor' }); stlocSlot(rngInstrs, 0, 's');
    ldlocSlot(rngInstrs, 0, 's'); rngInstrs.push({ op: 'stsfld', arg: 'int32 HaikuProgram::rng' });
    ldlocSlot(rngInstrs, 0, 's'); ldc(rngInstrs, 100); rngInstrs.push({ op: 'rem.un' });
    rngInstrs.push({ op: 'ret' });

    const cctorInstrs = [];
    ldc(cctorInstrs, RNG_SEED_SIGNED);
    cctorInstrs.push({ op: 'stsfld', arg: 'int32 HaikuProgram::rng' });
    cctorInstrs.push({ op: 'ret' });

    const rngLabelAddr = resolveAddresses(rngInstrs);
    const rngText = renderInstrs(rngInstrs, rngLabelAddr, '    ');
    const cctorLabelAddr = resolveAddresses(cctorInstrs);
    const cctorText = renderInstrs(cctorInstrs, cctorLabelAddr, '    ');
```

- [ ] **Step 3: Replace the Task 1 minimal `return` with the full listing**

Replace the existing:

```js
    return (
      '// ildasm-style disassembly emitted directly by HaikuScript — illustrative text\n' +
      '// only: not assembled into a real module, and not executed.\n' +
      '.class private auto ansi HaikuProgram\n' +
      '       extends [mscorlib]System.Object\n' +
      '{\n' +
      '  .method public hidebysig static int32 Compute() cil managed\n' +
      '  {\n' +
      '    .maxstack 8\n' +
      '    .locals init (\n' + localsDecl + '\n    )\n\n' +
      bodyText +
      '  } // end of method HaikuProgram::Compute\n\n' +
      '} // end of class HaikuProgram\n'
    );
```

with:

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

- [ ] **Step 4: Run a verification script exercising print/input/random**

```bash
cat > /tmp/il-check-3.js << 'EOF'
const { generateIl } = require('/mnt/c/Code/Fizzbash/haikuscript/haiku-core');
const ast = { type: 'Program', body: [
  { type: 'RandomStatement', target: 'x' },
  { type: 'PrintStatement', value: 'x' },
  { type: 'InputStatement', target: 'y' },
  { type: 'AdditionStatement', source: 'y', target: 'x' },
  { type: 'PrintStatement', value: 42 }
]};
const il = generateIl(ast, 12345);
console.log(il);

if (!il.includes('.field private static int32 rng')) throw new Error('missing rng field');
if (!il.includes('HaikuProgram::NextRandom()')) throw new Error('missing NextRandom call');
if (!il.includes('HaikuHost::Print(int32)')) throw new Error('missing Print call');
if (!il.includes('HaikuHost::Input()')) throw new Error('missing Input call');
if (!il.includes('.cctor')) throw new Error('missing .cctor');
if (!il.includes('ldc.i4 12345')) throw new Error('expected seed 12345 emitted as ldc.i4 12345 in .cctor');
console.log('OK');
EOF
node /tmp/il-check-3.js
rm /tmp/il-check-3.js
```

Expected: prints the full listing (rng field, `NextRandom`, `Compute`, `.cctor`), then `OK`.

- [ ] **Step 5: Commit**

```bash
cd /mnt/c/Code/Fizzbash/haikuscript
git add haiku-core.js
git commit -m "Add print/input/random codegen and full class wrapper to generateIl"
```

---

### Task 4: Wire the IL panel into the REPL

**Files:**
- Modify: `repl.html:84-87` (add a new `<details>` panel after the WAT panel)
- Modify: `repl.js:58-79` (clear the new panel on each run; call `generateIl` alongside `generateWat` using a shared seed)

**Interfaces:**
- Consumes: `HaikuCore.generateIl(ast, seed)` (produced by Tasks 1–3).
- Produces: nothing new for later tasks — this is the last task.

- [ ] **Step 1: Add the IL panel to `repl.html`**

In `repl.html`, the WAT panel currently reads (around line 84):

```html
      <details>
        <summary>WebAssembly Text (.wat)</summary>
        <pre id="wat"></pre>
      </details>
```

Replace it with:

```html
      <details>
        <summary>WebAssembly Text (.wat)</summary>
        <pre id="wat"></pre>
      </details>
      <details>
        <summary>CIL / IL (ildasm-style)</summary>
        <pre id="il"></pre>
      </details>
```

- [ ] **Step 2: Clear the new panel on each run**

In `repl.js`, the `run()` function currently starts (around line 58):

```js
    $('result').className = 'result';
    $('result').textContent = 'Running…';
    $('tokens').textContent = '';
    $('ast').textContent = '';
    $('wat').textContent = '';
    $('printed').textContent = '';
```

Add the new panel to the reset block:

```js
    $('result').className = 'result';
    $('result').textContent = 'Running…';
    $('tokens').textContent = '';
    $('ast').textContent = '';
    $('wat').textContent = '';
    $('il').textContent = '';
    $('printed').textContent = '';
```

- [ ] **Step 3: Generate IL alongside WAT using a shared seed**

In `repl.js`, the Phase 3 block currently reads (around line 77):

```js
      setStatus('Phase 3 — generating WAT & assembling WASM…', 'busy');
      const wat = HaikuCore.generateWat(ast, Date.now());
      $('wat').textContent = wat;
```

Replace it with:

```js
      setStatus('Phase 3 — generating WAT & CIL, assembling WASM…', 'busy');
      const seed = Date.now();
      const wat = HaikuCore.generateWat(ast, seed);
      $('wat').textContent = wat;
      const il = HaikuCore.generateIl(ast, seed);
      $('il').textContent = il;
```

- [ ] **Step 4: Manually verify in the browser**

Run:

```bash
cd /mnt/c/Code/Fizzbash/haikuscript
npm run serve
```

Then, in a browser: open `http://localhost:3000/repl.html`, click **▶ Run** (the default sample loads automatically), and confirm:
- The **CIL / IL (ildasm-style)** panel appears right after the WAT panel.
- Expanding it shows a `.class private auto ansi HaikuProgram { ... }` listing with `IL_XXXX:` addressed instructions, a `NextRandom()` method, and a `.cctor()`.
- The existing **WAT**, **Tokens**, **AST**, **Result**, and **Printed Output** panels still behave exactly as before (the WASM path still executes and produces a `Result:` value).

Stop the server (`Ctrl+C`) once confirmed.

- [ ] **Step 5: Commit**

```bash
cd /mnt/c/Code/Fizzbash/haikuscript
git add repl.html repl.js
git commit -m "Show generated CIL/IL alongside WAT in the REPL"
```
