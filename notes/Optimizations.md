# Compiler Optimizations & Intermediate Representations

This document outlines the compiler middle-end, intermediate representations (IR), and common optimization strategies used to make generated code execute as fast as possible.

---

## The Compiler Middle-End & IR

Before generating target machine code, compilers translate the AST into a language-neutral **Intermediate Representation (IR)**. 

* **Why use an IR?**
  * If you have $N$ front-ends (programming languages) and $M$ back-ends (target architectures like x86, ARM, WebAssembly), an IR reduces the need to write $N \times M$ compilers. 
  * Instead, you compile $N$ front-ends to the IR, perform optimizations on the IR, and translate the IR to $M$ back-ends (requiring only $N + M$ translation layers).
* **Single Static Assignment (SSA) Form:**
  * Most modern compiler IRs (like LLVM's IR) require that every variable is assigned **exactly once**, and every variable is defined before it is used.
  * *Non-SSA Code:*
    ```text
    y = 1
    y = y + 2
    x = y
    ```
  * *SSA Equivalent:*
    ```text
    y1 = 1
    y2 = y1 + 2
    x1 = y2
    ```
  * *Benefit:* Makes data flow analysis and optimizations (like dead code elimination) mathematically simple to prove correct.

---

## Common Compiler Optimizations

Compilers analyze and rewrite the IR code to reduce instruction counts, minimize memory access, and exploit hardware features.

### 1. Local Optimizations (AST/Statement Level)
* **Constant Folding:**
  * Compiling constant operations at compile-time instead of runtime.
  * *Before:* `x = 3 + 5`
  * *After:* `x = 8`
* **Constant Propagation:**
  * Replacing variables that have known constant values with the constants themselves.
  * *Before:*
    ```text
    x = 10
    y = x + 5
    ```
  * *After:*
    ```text
    x = 10
    y = 15
    ```
* **Dead Code Elimination (DCE):**
  * Removing instructions or entire execution blocks that have no effect on the program's output.
  * *Before:*
    ```text
    x = 42      ;; Never read again
    if (false) {
      do_something()
    }
    ```
  * *After:* (Empty / removed entirely)

### 2. Loop Optimizations
* **Loop Unrolling:**
  * Duplicating a loop's body to run multiple iterations per cycle, reducing the overhead of checking the loop condition and updating indices.
  * *Before:*
    ```text
    for (i = 0; i < 3; i++) {
      print(i);
    }
    ```
  * *After:*
    ```text
    print(0);
    print(1);
    print(2);
    ```
* **Loop-Invariant Code Motion (Hoisting):**
  * Moving calculations that do not change inside the loop to the outside.
  * *Before:*
    ```text
    for (i = 0; i < 1000; i++) {
      arr[i] = x + y;  ;; x + y is constant across all iterations
    }
    ```
  * *After:*
    ```text
    temp = x + y;
    for (i = 0; i < 1000; i++) {
      arr[i] = temp;
    }
    ```

### 3. Interprocedural Optimizations
* **Function Inlining:**
  * Replacing a function call instruction with the actual body of the called function.
  * *Benefit:* Eliminates the CPU overhead of creating a stack frame, jumping to a memory address, and returning.
  * *Before:*
    ```text
    func square(n) { return n * n }
    y = square(x)
    ```
  * *After:*
    ```text
    y = x * x
    ```

---

## Hardware-Level Back-End Optimizations

After IR optimizations, the compiler backend translates the code to target assembly and optimizes for physical hardware.

* **Register Allocation (Graph Coloring):**
  * A computer has an infinite number of variables, but a CPU only has a few dozen physical storage slots called **registers**.
  * The backend builds an interference graph of variables that are active at the same time and uses **graph coloring algorithms** to map them to the minimum number of registers, swapping variables in and out of slow RAM (spilling) only when necessary.
* **Instruction Scheduling:**
  * Reordering instructions to prevent CPU execution pipeline stalls (e.g., placing independent operations immediately after a slow memory fetch, so the CPU doesn't sit idle waiting for RAM).
