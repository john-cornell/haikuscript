# Memory Management: Manual, GC, and Ownership

This document details how compiled and interpreted programs allocate, track, and reclaim memory.

---

## The Stack vs. The Heap

All program memory is conceptually divided into two primary zones:

| Property | The Stack | The Heap |
| :--- | :--- | :--- |
| **Allocation Speed** | Extremely fast (modifying a CPU stack pointer). | Slower (allocator must search for an empty block). |
| **Lifespan** | Tied strictly to function scope. | Can outlive the function that created it. |
| **Sizing** | Must have a fixed size known at compile-time. | Can grow or shrink dynamically at runtime. |
| **Management** | Automatically cleaned up when function returns. | Requires explicit cleanup (manually or by runtime). |

---

## 1. Manual Memory Management

The developer must explicitly tell the OS to allocate memory on the heap and explicitly declare when it is safe to free it.

* **How it works:**
  * Uses calls like `malloc(size)` to reserve bytes and `free(pointer)` to release them in C, or `new` and `delete` in C++.
* **Characteristics:**
  * **Pros:**
    * Zero runtime overhead: No garbage collection pauses or tracking structures.
    * Complete control over hardware.
  * **Cons:**
    * Highly error-prone:
      * **Memory Leaks:** Forgetting to free memory, causing the application to consume more RAM over time.
      * **Dangling Pointers / Use-After-Free:** Releasing memory and trying to read it again, leading to security flaws or crashes.
      * **Double Frees:** Freeing the same memory address twice, corrupting allocator metadata.
* **Examples:** C, C++, Assembly.

---

## 2. Automatic Memory Management: Garbage Collection (GC)

The runtime environment automatically tracks heap allocations and sweeps away memory that is no longer being referenced.

### A. Reference Counting
* **How it works:**
  * Every object on the heap carries an internal counter tracking how many references point to it.
  * When a reference goes out of scope, the counter decrements. If the count reaches 0, the object is immediately destroyed.
* **The Cycle Problem:** If Object A references Object B, and Object B references Object A, their reference counts will never drop to 0, causing a memory leak. Compilers use weak references to break these cycles.
* **Examples:** Swift, Python (CPython uses Reference Counting + a fallback cycle-detecting GC).

### B. Tracing Garbage Collectors
* **How it works:**
  * The GC periodically pauses execution (often called **Stop-the-World** pauses) to trace active pointers from root sources (stack, global variables).
  * **Mark-and-Sweep:** The GC marks all reachable objects, then sweeps the unmarked memory back into the allocator's pool.
  * **Generational GC:** Optimizes by dividing objects into generations. Since "most objects die young," it scans the newest allocations frequently and older allocations rarely.
* **Characteristics:**
  * **Pros:** Greatly reduces developer workload and prevents use-after-free errors.
  * **Cons:** Introduces latency/pauses and increases overall memory footprint (usually needs 2x more memory than manual allocation to perform efficiently).
* **Examples:** Java (HotSpot GC), JavaScript (V8's Orinoco GC), Go, C# (.NET GC).

---

## 3. Compile-Time Ownership & Borrowing

A modern paradigm that guarantees memory safety without manual freeing and without the runtime overhead of a garbage collector.

* **How it works (The Rust Model):**
  * **Ownership:** Every value has a single owner variable. When the owner goes out of scope, the compiler automatically inserts cleanup code (like `free`) at that exact point.
  * **Borrowing:** Variables can borrow references (read-only or mutable), but the compiler's **borrow checker** enforces strict rules to ensure no reference can outlive the owner (preventing dangling pointers).
* **Characteristics:**
  * **Pros:** High-performance (AOT-style speed), safe memory layout, no GC pauses.
  * **Cons:** High compile-time complexity (the developer must satisfy the borrow checker's rigid logic).
* **Examples:** Rust.
