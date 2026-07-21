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
- Each **line** is one or more **words**; a word is either a run of 3+ letters (a
  dictionary word), a 1-2 character alpha-first token (a short variable name, see
  §3a), or a run of digits (a number literal).
- **Spaces and tabs don't matter; newlines do** — they end a line. Commas are
  stripped too, so you can punctuate a line for readability if you like.
- Every line is scored against a repeating meter, `5, 7, 5`, that cycles every three
  code lines. Each word has a fixed syllable count; a line's words must total exactly
  its target or you get `Poetic meter broken`. Blank lines are not code and are skipped.

The hand lexer is essentially:

```javascript
source.split('\n')                                               // one entry per physical line
      .map(line => line.replace(/,/g, ''))
      .map(line => line.match(/[a-zA-Z]{3,}|[a-zA-Z][a-zA-Z0-9]?|[0-9]+/g) || [])   // words on that line
```

Numbers can be spelled out (`zero`, `one`, `ten`, …) or written as digits directly
(`0`, `42`, `1000`) — syllables for digit literals are computed algorithmically
(spoken English number names, so `42` = "forty-two" = 3 syllables), not looked up
in a fixed list, so arbitrarily large numbers work.

---

## 3. How to write a line

Think of every line as a short **command sentence**. It is made of words that each
play a **role** (a “part of speech”), arranged in a fixed **pattern**. Then you pad
the line with filler words until it hits its syllable target.

### 3a. The word roles

| Role | Words | Notes |
| ---- | ----- | ----- |
| **Command** (the verb that starts the instruction) | `set`, `add`, `loop`, `end`; the random words `dream` / `random` / `something` / `imagine` / `randomly`; the print words `print` / `say` / `speak` / `shout` / `printout` / `announce` / `declare` / `reveal` / `utter` / `recite` / `vocalize` / `articulate`; the input words `ask` / `guess` / `prompt` / `input` | comes first |
| **Variable** (the thing acted on) | `x`, `y`, `z`, `count`, **or any 1-2 character name starting with a letter** (`a`, `g`, `r3`, `ww`, …) | not a fixed list — see below |
| **Number** | spelled (`zero`, `one`, `ten`, …) or digits (`0`, `42`, …) | literals of any size |
| **Connector** (glue the pattern needs) | `to`, `until`, `equals` | fixed position |
| **Comparison** (loop condition only, see below) | `equals`; `less` / `under` / `below` (<); `more` / `over` / `above` (>) | one per comparison term |
| **Negation** (loop condition only) | `not` — negates the single comparison right after it | prefix |
| **Join** (loop condition only) | `and`, `or`, `xor` — chains another comparison term | between terms |
| **Filler** (meaning-free padding) | `the`, `is`, `it`, `now`, `user`, `gently`, `quietly`, `suddenly`, `always`, `beautifully`, `telling`, `sequence` | dropped before the program runs |

Only the **command, variable, number, and connector** words carry meaning, and they
must appear in the right order. **Filler words are discarded before the program is
understood**, so you can sprinkle them almost anywhere to fix your syllable count
without changing what the line does. `user` exists purely so `ask user the g` reads
naturally — it contributes nothing beyond its 2 syllables, identically to `the`.

**Short variable names** aren't a fixed dictionary entry like `x`/`y`/`z`/`count` —
any 1-2 character token starting with a letter (second character, if present, can be
a letter or digit) is accepted as a variable automatically. Its syllable count comes
from how the name is *spoken*: each character is read as a letter or digit name
(`w` = "double-u" = 3 syllables, `3` = "three" = 1 syllable), so `r3` = 2 syllables
and `ww` = 6. This is an exact lookup table, not a guess — every letter A-Z and
digit 0-9 has one fixed, unambiguous spoken-syllable count.

**Comparisons and logical joins** only exist inside a loop's `until` condition —
there's no general-purpose boolean expression usable elsewhere (no `if`, no boolean
variables). A condition is a **flat chain** of comparisons: `⟨left⟩ ⟨comparison⟩
⟨right⟩`, optionally prefixed by `not`, optionally continued with `and`/`or`/`xor`
followed by another comparison term. There's deliberately **no precedence and no
parentheses** — `x equals 1 and y equals 2 or z equals 3` evaluates strictly left to
right: `((x==1) and (y==2)) or (z==3)`. Only three base comparisons exist
(`equals`, `less`/`under`/`below`, `more`/`over`/`above`), but `not` derives the
rest for free: `not equals` is `!=`, `not less`/`not under`/`not below` is `>=`,
`not more`/`not over`/`not above` is `<=`.

### 3b. The line patterns

Using ⟨…⟩ to mean “put a word of this role here”:

| What you want | Pattern | Example |
| ---- | ---- | ---- |
| Store a value | `set ⟨variable⟩ to ⟨number \| variable⟩` | `Set x to zero` |
| Store a random number | `set ⟨variable⟩ to ⟨random⟩` | `Set x to something` |
| Store a random (verb form) | `⟨random⟩ ⟨variable⟩` | `Dream x` |
| Add (target += source) | `add ⟨number \| variable⟩ to ⟨variable⟩` | `Add one to count` |
| Print a value | `⟨print⟩ ⟨number \| variable⟩` | `Print the x` |
| Read a value in | `set ⟨variable⟩ to ⟨input⟩` | `Set g to input` |
| Read a value in (verb form) | `⟨input⟩ ⟨variable⟩` | `Guess the g` |
| Start a loop | `loop until [not] ⟨left⟩ ⟨comparison⟩ ⟨right⟩ [(and\|or\|xor) [not] ⟨left⟩ ⟨comparison⟩ ⟨right⟩]…` | `Loop until count equals ten`, `Loop until x more 4`, `Loop until not x less y`, `Loop until x equals 3 and a equals b` |
| End a loop | `end loop` | `Gently end the loop` |

`to` is optional everywhere it appears above — the parser skips it if present but
never requires it. It's there for phrasing, not grammar.

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
  a random word, a print word, or an input word.
- **`to` separates the two operands** in `set … to …` and `add … to …` (and is
  optional in the print/input patterns).
- **A loop is two lines apart:** `loop until … equals …` opens it; `end loop`
  (usually padded, e.g. `Gently end the loop always`) closes it. Everything between
  them is the loop body.
- **Reach for filler to fix meter**, never to change logic — filler is invisible to
  the compiler.
- **The final answer is always `x`.** Whatever `x` holds when the program ends is
  what `compute()` returns. `Print` statements surface values *during* the run —
  useful inside a loop, where each iteration overwrites the previous value and only
  the last one would otherwise be visible — but only `x`'s last value is the return.

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
| `EQ`         | `equals` (2)                                                                                                  | `==` in a comparison |
| `LT`         | `less` (1), `under` (2), `below` (2)                                                                          | `<` in a comparison |
| `GT`         | `more` (1), `over` (2), `above` (2)                                                                           | `>` in a comparison |
| `NOT`        | `not` (1)                                                                                                     | negates the comparison right after it |
| `AND`        | `and` (1)                                                                                                     | chains another comparison term (both must hold) |
| `OR`         | `or` (1)                                                                                                      | chains another comparison term (either may hold) |
| `XOR`        | `xor` (1)                                                                                                     | chains another comparison term (exactly one must hold) |
| `END`        | `end` (1)                                                                                                     | close a loop body |
| `IDENTIFIER` | `x` `y` `z` `count` (1 each, fixed dictionary entries), **or** any 1-2 character alpha-first name — syllables computed from its spoken letters/digits (see §3a) | a variable |
| `NUMBER`     | spelled (`zero` = 2 → 0, `one` = 1 → 1, `ten` = 1 → 10, …), **or** digits (`0`, `42`, …) — syllables computed algorithmically for any magnitude | integer literals |
| `RANDOM`     | `dream` (1), `random` (2), `something` (2), `imagine` (3), `randomly` (3)                                      | roll a random 0–99 |
| `PRINT`      | `print` `say` `speak` `shout` (1), `printout` `announce` `declare` `reveal` `utter` `recite` (2), `vocalize` (3), `articulate` (4) | surface a value mid-run (see §5) |
| `INPUT`      | `ask` `guess` `prompt` (1), `input` (2)                                                                       | read a value in from the host (see §5) |
| `IGNORE`     | `the` `is` `it` `now` `user` (1–2), `gently` `always` `telling` (2), `quietly` `suddenly` `sequence` (3), `beautifully` (4)  | filler — syllables only, no logic |

---

## 5. What each pattern means (the AST)

After the syllable audit, the meaningful tokens are parsed into statements:

- **`set <var> to <number|var>`** → assignment (`x = 0`, `x = y`).
- **`<random> <var>`** or **`set <var> to <random>`** → assign a random 0–99.
- **`add <source> to <target>`** → `target = target + source`.
- **`<print> <number|var>`** → surface a value immediately, without changing any
  variable. Compiles to a call into a host-supplied `env.print` import — the CLI
  logs it to the console, the browser REPL collects it into the **Printed Output**
  panel.
- **`<input> <var>`** or **`set <var> to <input>`** → read a value in from the host
  and store it. Compiles to a call into a host-supplied `env.input` import — the CLI
  blocks on a synchronous stdin read, the REPL uses `window.prompt`. Values are
  plain `i32` numbers; there's no character type, so a "guess a letter" program has
  to encode letters as numbers (e.g. a code 1–26) rather than reading a literal `A`.
- **`loop until <condition>` … `end loop`** → run the body while the condition is
  **false**, exiting the instant it becomes true. A condition is a flat chain of
  comparison terms: each term is `<left> <op> <right>` (`op` is `eq`/`lt`/`gt`),
  optionally negated by a leading `not`; terms after the first carry a `join`
  (`and`/`or`/`xor`) saying how they combine with everything before them, evaluated
  strictly left to right with no precedence. Either side of any term can be a
  number or a variable — comparing two variables (`loop until g equals s`) is what
  lets a "keep guessing until it matches the secret" program work.
- **Filler (`IGNORE`) words** produce no statement at all.

`compute()` returns the final value of **`x`** — `print` only surfaces values
*during* the run, it doesn't change what gets returned.

---

## 6. What the language cannot do

- **Only addition** — no subtract, multiply, divide, or modulo in the language.
- **Comparisons and logic only exist inside a loop condition** — `equals`/`less`/`more`,
  `not`, and `and`/`or`/`xor` chain into the one place a boolean value is ever used
  (deciding whether a loop exits). There's no `if`, no boolean variable type, and no
  way to compute a comparison's result and assign or print it directly.
- **No precedence, no parentheses** — a condition is a flat left-to-right chain;
  `and`/`or`/`xor` are not distinguished by binding strength, and there's no way to
  group a sub-expression. `not` only ever negates the single term right after it,
  never a whole parenthesized group.
- **No strings or arrays** — every variable is a single `i32` number. A word or a
  sequence of guessed letters can't be represented directly; you'd need one
  variable per letter position, encoded as a number.
- **Variables aren't a fixed list anymore**: `x`, `y`, `z`, `count`, plus any 1-2
  character alpha-first name — but there's still only **one return value**, `x`.
- **Randomness and input are the exceptions** to "only addition and one return
  value": the compiler emits its own self-contained xorshift PRNG into the WASM, so
  `RANDOM` words work with no host help, while `PRINT` and `INPUT` cross the module
  boundary via host imports (`env.print` / `env.input`) — see §5.

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

CLI diagnostic flags: `--dump-tokens`, `--dump-ast`, `--compile`, `--run`, `--json-errors`.
`--run` assembles and executes immediately (no files written), wiring `env.print`
to `console.log` and `env.input` to a blocking stdin read. `--compile` writes its
`.wat`/`.wasm` output to `build/`, separate from the `.hk` source.

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

More worked examples live under `src/`: `named_vars.hk` and `syllable_check.hk`
(short variable names), `ten_randoms.hk` (`print` inside a loop), `input_demo.hk`
(all four `INPUT` keywords, plus the `ask user` filler phrase), `guess_number.hk`
(a minimal guessing game — `loop until g equals s` keeps reading guesses until one
matches a random secret, then reports how many tries it took), and
`comparisons_demo.hk` (all six comparison/logical words — `less`/`more`, `not`,
`and`/`or`/`xor` — each in its own self-contained counting loop with a predictable
printed result). Note that comparisons only exist inside a loop condition (§3a),
so `guess_number.hk` still can't give higher/lower hints even with `<`/`>` now
available — it's "keep guessing," not a classic number-guessing game.

---

## 9. Where each rule lives

| Concern | File |
| ------- | ---- |
| Lexing (lines/words), syllable audit, parsing, code generation | `haiku-core.js` (`tokenize`, `parseProgram`, `generateWat`) |
| Vocabulary, syllables, word roles | `haiku-core.js` (`VOCAB`) |
| Editor syntax highlighting *(optional, not used at runtime)* | `grammar.js` + `queries/highlights.scm` |
