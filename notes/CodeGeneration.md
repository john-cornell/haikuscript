# Code Generation & Execution Ordering in Compilers

This document outlines the high-level concepts of code generation, instruction models, and the differences in operation ordering across compilers, with reference to the **HaikuScript** compiler.

---

## Code Generation (Compiling to Target Code)

* **Definition:** The final compilation phase that translates a structured, hierarchical **Abstract Syntax Tree (AST)** into a linear sequence of target instructions (e.g., WebAssembly, machine code, JVM bytecode, or assembly language).
* **The "Verb-Symbol-Symbol" Abstraction:**
  * At a low level, target machine code represents execution as actions (**verbs**) acting on storage locations (**symbols** / registers / memory addresses).
  * **Three-Address Code (TAC):** A common Intermediate Representation (IR) used by compilers where each instruction has at most one operator (verb) and three operands (symbols).
    * *Example:* `ADD x, y, z` (meaning: add `y` and `z` and store in `x`).
  * **HaikuScript Reference:**
    * In [`generateWat`](file:///c:/Code/Fizzbash/haikuscript/haiku-core.js#L211-L259), the compiler loops through AST nodes and emits text-based WebAssembly instructions.

---

## Stack-Based vs. Register-Based Instruction Ordering

The way a target machine represents memory dictates how the compiler must order its output operations:

### 1. Stack-Based Machines (e.g., WebAssembly, JVM bytecode)
* Uses a virtual **evaluation stack** to hold operands and execute instructions.
* Operations are compiled in **Postfix (Reverse Polish) Notation**.
* **Ordering Rule:** The compiler must push arguments onto the stack *before* invoking the operator (verb).
* **HaikuScript Addition Example:**
  * For an addition node: `{ type: "AdditionStatement", source: "x", target: "y" }`
  * The compiler orders operations as:
    ```wat
    local.get $y   ;; Symbol 1: Push target y's value onto the stack
    local.get $x   ;; Symbol 2: Push source x's value onto the stack
    i32.add        ;; Verb: Pop y, Pop x, add them, and push result back
    local.set $y   ;; Write-back: Pop result and store it back into y
    ```

### 2. Register-Based Machines (e.g., x86, ARM, RISC-V)
* Uses CPU registers (fast-access slots inside the processor) to hold operands.
* Operations directly specify their source and destination registers.
* **Ordering Rule:** Instructions specify inputs and outputs inline, and execute linearly.
* **Equivalent Addition Example (ARM Assembly):**
  ```assembly
  ADD r0, r0, r1   ;; Add value in register r1 to r0, store result in r0
  ```

---

## Why Ordering of Operations Differs Between Compilers

Different compilers and language designs handle the sequence of operations in distinct ways:

* **Evaluation Order (Left-to-Right vs. Unspecified):**
  * In Java and JavaScript, the language specification guarantees strict left-to-right evaluation of expression operands.
  * In C and C++, the order of evaluation of operands and function arguments is often **unspecified**. A compiler compiling `f() + g()` can choose to call `g()` first or `f()` first, depending on which ordering produces faster machine code or utilizes registers better.
* **Instruction Scheduling (CPU Optimization):**
  * Modern compiler backends (like LLVM) reorder instructions to prevent hardware pipeline stalls.
  * *Example:* Reading from RAM is slow. The compiler might schedule a memory load (`load`) several instructions *before* the operation that actually needs the data, interleaving other independent operations in between to keep the CPU busy.
* **Eager vs. Lazy Compilation:**
  * Eager compilers generate machine code for all operations up front.
  * Just-In-Time (JIT) compilers (like V8) parse and compile code dynamically, ordering operations based on runtime usage profiling, sometimes skipping compilation of cold functions entirely.
