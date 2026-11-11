# Semantics notes

This file records the rules the implementation follows.  It is deliberately
short; the README is the user-facing guide.

## Stages

- A **compile-time value** is a JavaScript value produced without reading a
  runtime binding.  Literals, `<const>` values, pure builtins and compile-time
  API results are compile-time values.
- A **runtime value** is anything that is only known when the generated program
  runs.  Function parameters, normal `const`/`let`/`var` bindings and imported
  runtime values are runtime values.
- `<const>` never changes stage.  If its initializer needs a runtime value, the
  compiler reports `CT2001`.

## Evaluation vs. inclusion

The compiler distinguishes:

1. *Evaluating* a condition / iterable / discriminant to decide what code to
   include.
2. *Including* code that may itself reference runtime values.

`<if>(a) { console.log(a) }` lowers to a runtime `if` because evaluating `a`
needs runtime; the included body still references `a`, which is fine.
`<if>(<const> b) { ... }` is evaluated at compile time because `b` is known.

## Per-node lowering

`<if>`, `<for>` and `<switch>` decide independently:

| Construct | Compile-time input | Runtime input |
| --- | --- | --- |
| `<if>` | include chosen branch | `if (cond) ...` |
| `<for>` | unroll body per item | `for (const x of iterable) ...` |
| `<switch>` | include chosen case | `switch (value) ...` |

A runtime node can contain a compile-time node; the compiler keeps descending.

## `<fn>`

- Clauses are collected at module top level.
- The call site decides the stage:
  - all arguments compile-time → find the first clause whose guard is true and
    evaluate its body at compile time;
  - any argument runtime → emit a runtime dispatcher that calls clause functions
    in order and checks a private no-match sentinel.
- Guards must be pure.  `<await>`, `<import>` and `<export>` are rejected inside
  `<fn>`.
- A runtime clause that uses `<const>` with a runtime parameter is a stage error.

## `<await>` and the barrier

- `<await>` evaluates a compile-time API result.  It is not runtime `await`.
- The Babel transform is synchronous; a Promise result is `CT4001`.
- The CLI orders the module graph so that, before an awaiting module is
  compiled, the other importers of its compile-time dependencies have reached
  their compile-time completion point.
- The awaiting module is excluded from its own barrier.  A `register` before the
  `<await>` counts; one after it does not.
- Unsatisfiable ordering is reported as a cycle/deadlock (`CT5002`/`CT5003`).

## File extensions

Macro source files use `.ctjs`; compiled output is `.js`.  Compile-time
`<import>` paths target `.ctjs`.  When a runtime ESM import is emitted for an
imported `<fn>` group, its path is rewritten to `.js`.

## Deliberate simplifications

- No AST values, quote/splice, or hygienic macro expansion.
- Compile-time values are plain JS values; object identity is not preserved when
  a value is embedded in several runtime locations.
- `<const>` supports simple identifiers only.
- No async compile-time work in the Babel transform.
- No source maps yet.
