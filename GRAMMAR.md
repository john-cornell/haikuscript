# HaikuScript Language Grammar

*Part of the HaikuScript docs: [README](README.md) (how to build & run) · [CODEBASE](CODEBASE.md) (full source) · GRAMMAR (this file).*

HaikuScript is a toy programming language whose source code is **haiku poetry**. A
program is one or more three-line stanzas; every line must scan to the classic
**5 / 7 / 5** syllable meter, and every word must come from a fixed dictionary.
Valid poetry compiles to WebAssembly and runs.

If you just want to **write** HaikuScript, read section 3 (“How to write a line”).
The rest explains how the grammar works under the hood.

---

## 1. How the grammar is implemented

The grammar is simple enough that it's **tokenized by hand** — there's no parser
generator in the run path:

1. **Lexer** — `haiku-core.js` (`tokenize`). Splits the source into lines and words
   with a one-line regex, audits syllables, and maps each word to its role.
2. **Parser + codegen** — `haiku-core.js` (`parseProgram`, `generateWat`). Builds the
   AST and emits WebAssembly.

> **Optional:** a Tree-sitter grammar (`grammar.js`) and query file
> (`queries/highlights.scm`) are kept in the repo so an editor can syntax-highlight
> `.hk` files. They are **not used to run or compile** — for a language this small a
> generated parser is overkill. For a bigger language you'd let Tree-sitter own the
> front end; the rules in `grammar.js` describe exactly the structure the hand lexer
> reproduces.

---

## 2. The shape of a program

- A **program** is a sequence of **stanzas**, optionally separated by blank lines.
- A **stanza** is **three lines**.
- Each **line** is one or more **words**; a word is letters only (`/[a-zA-Z]+/`).
- **Spaces and tabs don't matter; newlines do** — they end a line.
- Every line is scored against a repeating meter, `5, 7, 5`, that cycles every three
  code lines. Each word has a fixed syllable count; a line's words must total exactly
  its target or you get `Poetic meter broken`. Blank lines are not code and are skipped.

The hand lexer is essentially:

```javascript
source.split('\n')                    // one entry per physical line
      .map(line => line.match(/[a-zA-Z]+/g) || [])   // words on that line
```

Numbers are spelled out (`zero`, `one`, `ten`) because digits aren't legal words.

---

## 3. How to write a line

Think of every line as a short **command sentence**. It is made of words that each
play a **role** (a “part of speech”), arranged in a fixed **pattern**. Then you pad
the line with filler words until it hits its syllable target.

### 3a. The word roles

| Role | Words | Notes |
| ---- | ----- | ----- |
| **Command** (the verb that starts the instruction) | `set`, `add`, `loop`, `end`, and the random words `dream` / `random` / `something` / `imagine` / `randomly` | comes first |
| **Variable** (the thing acted on) | `x`, `y`, `z`, `count` | the only four |
| **Number** | `zero` (0), `one` (1), `ten` (10) | literals |
| **Connector** (glue the pattern needs) | `to`, `until`, `equals` | fixed position |
| **Filler** (meaning-free padding) | `the`, `is`, `it`, `gently`, `quietly`, `suddenly`, `always`, `beautifully`, `telling`, `sequence` | dropped before the program runs |

Only the **command, variable, number, and connector** words carry meaning, and they
must appear in the right order. **Filler words are discarded before the program is
understood**, so you can sprinkle them almost anywhere to fix your syllable count
without changing what the line does.

### 3b. The line patterns

Using ⟨…⟩ to mean “put a word of this role here”:

| What you want | Pattern | Example |
| ---- | ---- | ---- |
| Store a value | `set ⟨variable⟩ to ⟨number \| variable⟩` | `Set x to zero` |
| Store a random number | `set ⟨variable⟩ to ⟨random⟩` | `Set x to something` |
| Store a random (verb form) | `⟨random⟩ ⟨variable⟩` | `Dream x` |
| Add (target += source) | `add ⟨number \| variable⟩ to ⟨variable⟩` | `Add one to count` |
| Start a loop | `loop until ⟨variable⟩ equals ⟨number⟩` | `Loop until count equals ten` |
| End a loop | `end loop` | `Gently end the loop` |

Case doesn't matter — every word is lower-cased before it's looked up, so `Set` and
`set` are the same.

### 3c. Building a line step by step

Suppose the second line of a stanza must be **7 syllables** and you want `y = 1`:

1. Start from the pattern: `Set y to one` → `set`(1) `y`(1) `to`(1) `one`(1) = **4 syllables**.
2. You need 3 more. Pick a 3-syllable filler word: `quietly`.
3. Final line: `Set y to one quietly` = **7 syllables**. ✓

The filler changed nothing about the logic (`y` is still `1`); it only made the line
scan. This “write the command, then pad to meter with filler” loop is the whole art
of writing HaikuScript.

### 3d. Rules of thumb

- **Command word first.** Every instruction begins with `set`, `add`, `loop`, `end`,
  or a random word.
- **`to` separates the two operands** in `set … to …` and `add … to …`.
- **A loop is two lines apart:** `loop until … equals …` opens it; `end loop`
  (usually padded, e.g. `Gently end the loop always`) closes it. Everything between
  them is the loop body.
- **Reach for filler to fix meter**, never to change logic — filler is invisible to
  the compiler.
- **The answer is always `x`.** Whatever `x` holds at the end is what the program
  returns; there is no `print` or `return`.

---

## 4. Vocabulary reference (`VOCAB`)

Every word must appear here or you get
`Forbidden word "…" is outside the allowable vocabulary dictionary`. Each entry has a
**syllable count** and a **token type** (its role).

| Token type   | Words (syllables)                                                                                             | Meaning |
| ------------ | ------------------------------------------------------------------------------------------------------------- | ------- |
| `ASSIGN`     | `set` (1)                                                                                                     | begin an assignment |
| `TO`         | `to` (1)                                                                                                      | separator in `set … to …` / `add … to …` |
| `ADD`        | `add` (1)                                                                                                     | begin an addition |
| `LOOP`       | `loop` (1)                                                                                                    | begin / end a loop |
| `UNTIL`      | `until` (2)                                                                                                   | loop condition intro |
| `EQ`         | `equals` (2)                                                                                                  | equality in a loop condition |
| `END`        | `end` (1)                                                                                                     | close a loop body |
| `IDENTIFIER` | `x` `y` `z` `count` (1 each)                                                                                   | the four variables |
| `NUMBER`     | `zero` (2 → 0), `one` (1 → 1), `ten` (1 → 10)                                                                  | integer literals |
| `RANDOM`     | `dream` (1), `random` (2), `something` (2), `imagine` (3), `randomly` (3)                                      | roll a random 0–99 |
| `IGNORE`     | `the` `is` `it` (1), `gently` `always` `telling` (2), `quietly` `suddenly` `sequence` (3), `beautifully` (4)  | filler — syllables only, no logic |

---

## 5. What each pattern means (the AST)

After the syllable audit, the meaningful tokens are parsed into statements:

- **`set <var> to <number|var>`** → assignment (`x = 0`, `x = y`).
- **`<random> <var>`** or **`set <var> to <random>`** → assign a random 0–99.
- **`add <source> to <target>`** → `target = target + source`.
- **`loop until <var> equals <number>` … `end loop`** → run the body **while
  `var != number`** (it exits the instant they're equal; equality is the only test).
- **Filler (`IGNORE`) words** produce no statement at all.

`compute()` returns the final value of **`x`**.

---

## 6. What the language cannot do

- **Only addition** — no subtract, multiply, divide, or modulo in the language.
- **Equality-only loops** — the single loop condition is `equals`.
- **Four variables**: `x`, `y`, `z`, `count`.
- **One output**: the final `x`.
- **Randomness is the exception** to “only addition”: the compiler emits its own
  self-contained xorshift PRNG into the WASM, so `RANDOM` words work with no host help.

---

## 7. Compilation pipeline

```
source (.hk)
  → Phase 1  tokenize + audit    (haiku-core: split lines/words, syllable check, emit tokens)
  → Phase 2  parseProgram        (tokens → statements)
  → Phase 3  generateWat         (statements → WebAssembly Text)
  → wabt                         (WAT → .wasm binary)
  → WebAssembly.instantiate      (compute() → result)
```

CLI diagnostic flags: `--dump-tokens`, `--dump-ast`, `--compile`, `--json-errors`.

---

## 8. Worked example

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

Meter check (each stanza is 5 / 7 / 5):

| Line | Words (syllables) | Total | Logic |
| ---- | ----------------- | ----- | ----- |
| `Set x to zero` | set1 x1 to1 zero2 | 5 | x = 0 |
| `Set y to one quietly` | set1 y1 to1 one1 quietly3 | 7 | y = 1 |
| `Set count to zero` | set1 count1 to1 zero2 | 5 | count = 0 |
| `Loop until the count` | loop1 until2 the1 count1 | 5 | while count != … |
| `equals ten beautifully` | equals2 ten1 beautifully4 | 7 | … 10 |
| `Set z to the x` | set1 z1 to1 the1 x1 | 5 | z = x |
| `Add y to the z` | add1 y1 to1 the1 z1 | 5 | z += y |
| `Set x to y suddenly` | set1 x1 to1 y1 suddenly3 | 7 | x = y |
| `Set y to the z` | set1 y1 to1 the1 z1 | 5 | y = z |
| `Add one to the count` | add1 one1 to1 the1 count1 | 5 | count += 1 |
| `Gently end the loop always` | gently2 end1 the1 loop1 always2 | 7 | end loop |
| `Quietly it is` | quietly3 it1 is1 | 5 | (filler) |

This computes the 10th Fibonacci number: **`compute()` → 55**.

---

## 9. Where each rule lives

| Concern | File |
| ------- | ---- |
| Lexing (lines/words), syllable audit, parsing, code generation | `haiku-core.js` (`tokenize`, `parseProgram`, `generateWat`) |
| Vocabulary, syllables, word roles | `haiku-core.js` (`VOCAB`) |
| Editor syntax highlighting *(optional, not used at runtime)* | `grammar.js` + `queries/highlights.scm` |
