# IL (CIL) Backend for the REPL — Design

## Purpose

For a tech talk demonstrating "one AST, multiple backends," add a second code
generator alongside the existing WASM pipeline (`generateWat`): a
`generateIl(ast, seed)` function that walks the same AST and emits an
authentic-looking, ildasm-style CIL (.NET Common Intermediate Language)
disassembly as text. The REPL shows it in a new panel next to the existing
WAT panel, so a single **Run** click visibly fans the same AST out into two
completely different instruction sets.

This is a textual-emission-only demo, not a real .NET build step: nothing is
assembled into an actual `.dll`, and nothing executes .NET IL. Only the
existing WASM path still runs the program; the IL panel is display-only. This
keeps the project's "no build step, everything runs client-side" philosophy
intact (see README.md's toolchain notes) — no `ilasm`/`ildasm.exe`, no .NET
SDK dependency.

## Scope

- New export `generateIl(ast, seed)` in `haiku-core.js`, alongside the
  existing `generateWat(ast, seed)`.
- New panel in `repl.html` / population logic in `repl.js`. No new button,
  no target toggle — both backends render on every **Run** click.
- No changes to tokenizer, parser, AST shape, or the WASM execution path.
- No automated tests added (see Testing below).

## Codegen design (`generateIl`)

Mirrors `generateWat`'s structure: a `walk(node)` function over the same AST
node types (`AssignmentStatement`, `AdditionStatement`, `RandomStatement`,
`PrintStatement`, `InputStatement`, `WhileLoopStatement`, `IfStatement`), and
an `emitCondition(terms)` helper for the flat and/or/xor comparison chains,
producing real CIL opcodes instead of WASM instructions.

**Locals.** Reuse the existing `collectIdentifiers()` pass (already shared
with `generateWat`) to determine the local variable set. Declared as
`.locals init ([0] int32 x, [1] int32 y, ...)`, in the same order
`generateWat` uses (`x` first, since `Compute()` always returns `x`).

**Instruction mapping**, matching each WAT instruction one-for-one:

| AST construct | WAT | CIL |
|---|---|---|
| assign constant/var | `i32.const` / `local.get` + `local.set` | `ldc.i4` / `ldloc` + `stloc` |
| add | `local.get`+`i32.add`+`local.set` | `ldloc`+`add`+`stloc` |
| comparison `eq`/`lt`/`gt` | `i32.eq`/`i32.lt_s`/`i32.gt_s` | `ceq`/`clt`/`cgt` |
| `not` (negate one term) | `i32.eqz` | `ldc.i4.0` + `ceq` |
| `and`/`or`/`xor` join | `i32.and`/`i32.or`/`i32.xor` | `and`/`or`/`xor` |
| `if`/`else` | structured `if`/`else`/`end` | `brtrue.s`/`brfalse.s` + labels |
| `while`/`until` loop | `block`/`loop`/`br_if`/`br` | `br.s` + labels, same invert-once-after-join rule as `generateWat` |
| print | `call $print` (import) | `call void HaikuHost::Print(int32)` |
| input | `call $input` (import) | `call int32 HaikuHost::Input()` |
| random | `call $next_random` (in-module func) | `call int32 HaikuProgram::NextRandom()` (in-module method) |

**Branch offsets.** Unlike `generateWat` (which emits structured
`if`/`loop`/`end` and never needs raw offsets), ildasm-style output shows
real `IL_XXXX:` byte addresses and branch targets as `IL_YYYY` labels. To
produce these without a full relaxation-pass assembler:

1. Walk the AST once, emitting an instruction list (`{op, arg}` plus label
   markers for loop-start/loop-end/if-else/if-end targets).
2. Always use the short branch forms (`br.s`/`brtrue.s`/`brfalse.s`, 2 bytes
   each) — realistic for HaikuScript's short poems, and it sidesteps the
   short/long form ambiguity since we don't compute real relative offsets.
3. Assign every instruction a fixed byte size from its opcode (short forms
   for locals 0–3 and constants -1..8, long forms otherwise; `call` is a
   fixed 5 bytes with a placeholder token) and accumulate `IL_XXXX` addresses
   in one pass, since branch instruction sizes don't depend on target
   distance under rule 2.
4. Resolve each label to the byte address of the instruction it points to.
5. Render each line as `IL_XXXX: mnemonic operand`, showing branch operands
   as the resolved `IL_YYYY` target label (matching real ildasm output,
   which always displays targets symbolically, not as raw signed deltas).

**Random / PRNG parity.** `generateIl` emits a second method,
`NextRandom()`, translating `generateWat`'s xorshift32 steps
(`shl`/`xor`/`shr_u`/`xor`/`shl`/`xor`/`rem_u`) into their literal CIL
equivalents (`shl`/`xor`/`shr.un`/`xor`/`shl`/`xor`/`rem.un`), backed by a
static field seeded in a `.cctor` from the same `seed` parameter
`generateWat` receives. Both backends run the *identical* PRNG algorithm in
different instruction sets — deliberately reinforcing the talk's point that
codegen differs, semantics don't.

**Output shape** (illustrative):

```
.class private auto ansi HaikuProgram
       extends [mscorlib]System.Object
{
  .field private static int32 rng

  .method private hidebysig static int32 NextRandom() cil managed
  {
    .maxstack 8
    .locals init ([0] int32 s)
    IL_0000: ldsfld     int32 HaikuProgram::rng
    IL_0005: stloc.0
    ...
    IL_00XX: ret
  } // end of method HaikuProgram::NextRandom

  .method public hidebysig static int32 Compute() cil managed
  {
    .maxstack 8
    .locals init (
        [0] int32 x,
        [1] int32 y
    )
    IL_0000: ldc.i4.0
    IL_0001: stloc.0
    ...
    IL_00XX: ldloc.0  // x
    IL_00XX: ret
  } // end of method HaikuProgram::Compute

  .method private hidebysig static void .cctor() cil managed
  {
    .maxstack 8
    IL_0000: ldc.i4  <seed>
    IL_0005: stsfld  int32 HaikuProgram::rng
    IL_000a: ret
  } // end of method HaikuProgram::.cctor
} // end of class HaikuProgram
```

## REPL wiring

- `repl.html`: add a `<details>` panel after the existing WAT panel:
  `<summary>CIL / IL (ildasm-style)</summary><pre id="il"></pre>`.
- `repl.js`: in `run()`, immediately after the existing
  `HaikuCore.generateWat(ast, Date.now())` call, add
  `HaikuCore.generateIl(ast, sameSeed)` (same seed value passed to both, so
  the two PRNG listings are directly comparable) and set
  `$('il').textContent` to the result. No new DOM listeners, no target
  selector — this fires on every existing **Run**/Ctrl+Enter invocation.
- Execution behavior is unchanged: only the WASM path instantiates and runs;
  the IL panel is purely textual output alongside Tokens/AST/WAT/Result.

## Error handling

`generateIl` runs after `tokenize`/`parseProgram` have already validated the
program, so — like `generateWat` — it can assume a well-formed AST and needs
no new error handling or reporting path. Failures during `generateWat` or
execution today already halt `run()` before reaching the IL call site if
they occur upstream (they won't, since both codegens run from the same
already-built AST) — no change to the existing `try`/`catch` in `run()`.

## Testing

Manual verification only, run in the browser REPL against a handful of
`.hk` samples chosen to exercise each construct: one with `if`/`else`, one
with a `while`/`until` loop, and one with `random`/`print`/`input`. Confirm
the emitted CIL listing is well-formed and that branch-target `IL_YYYY`
labels resolve to a real instruction address in the listing. No existing
automated test suite touches `generateWat`, so no automated tests are added
solely for `generateIl`.
