# ctjs

**Compile-time JavaScript — a staged macro layer for JavaScript.**

![status](https://img.shields.io/badge/status-experimental-orange)
![node](https://img.shields.io/badge/node-%5E22.18%20%7C%7C%20%3E%3D24.11-blue)
![license](https://img.shields.io/badge/license-MIT-green)

> **Status: experimental (v0.1).** The syntax and semantics may change before
> 1.0. This is a working research prototype, not a drop-in production
> preprocessor.

`ctjs` is a small compiler for code that should run at **build time** instead of
at runtime.  It uses Babel as its parser and AST layer; the primary interface is
the `ctjs` CLI.  You mark build-time code with `<const>`, `<if>`, `<for>`,
`<switch>`, `<fn>`, `<await>`, `<import>` and `<export>`; the compiler removes the
macros and emits ordinary JavaScript.

```js
<const> target = "prod";

<if>(target === "prod") {
  console.log("production");
} <else> {
  console.log("development");
}

<for>(plugin of ["a", "b"]) {
  console.log("plugin:", plugin);
}
```

becomes:

```js
console.log("production");
console.log("plugin:", "a");
console.log("plugin:", "b");
```

Values only become compile-time when they can be computed without runtime input.
When a condition, loop or switch depends on a runtime value, only that node is
lowered to a normal `if`, `for...of` or `switch`; everything below it is still
processed node by node.  The output is a mix of expanded code and ordinary
runtime control flow.

## Why "ctjs"?

`ctjs` is short for **compile-time JavaScript**:

- `ct` = compile time
- `js` = JavaScript

The project and CLI are `ctjs`.  It is not currently published to npm; this is a
personal, experimental repository.  Generated helper names use the reserved `__ctjs_`
prefix.  The name is about *staging*, not about being a general macro system or
a type system.

## What it is — and is not

**It is:**

- an explicit compile-time layer for JavaScript
- a way to eliminate branches and unroll loops at build time
- a compile-time module graph with an `<await>` barrier for cross-module
  collection
- a multi-clause `<fn>` system with compile-time evaluation and a runtime
  dispatcher

**It is not:**

- a general AST macro system (there is no quote/splice or hygiene)
- a replacement for TypeScript, Babel macros, or a bundler's `define`
- a sandbox for untrusted code
- a finished language

---

## Quick start

Requires Node `^22.18.0` or `>=24.11.0` (Babel 8's engine range).

```bash
git clone <your-repo-url>
cd ctjs
npm ci
npm test
npm run demo
```

`npm run demo` compiles and runs all examples in a temporary directory.

### File extensions

ctjs separates macro source from runtime output by extension:

| Kind | Extension | Example |
| --- | --- | --- |
| Macro source | `.ctjs` | `examples/basic.ctjs` |
| Compiled output | `.js` | `dist/basic.js` |

The CLI only accepts a `.ctjs` entry file and only scans `.ctjs` modules.
Compile-time `<import>` paths must target `.ctjs` files; when the compiler emits
a runtime ESM import for an imported `<fn>` group, it rewrites that path to
`.js`.  Ordinary runtime `import` statements can keep pointing at `.js` files.
GitHub highlights `.ctjs` as JavaScript via `.gitattributes`, and
`.vscode/settings.json` maps the extension for VS Code.

### CLI

Compile a project (including compile-time `<import>` / `<export>` modules):

```bash
npm run compile -- examples/basic.ctjs --stdout
npm run compile -- examples/collector/main.ctjs --out-dir dist
node dist/main.js
# collected: a, b, main
```

`npm run compile` is a thin wrapper around `node src/cli.js build`; everything
after `--` is passed to the CLI.

By default the CLI looks for barrier siblings in the entry file's directory.
For a larger project, point it at the project root so it can find other
importers of the same compile-time module:

```bash
npm run compile -- src/main.ctjs --root . --out-dir dist
```

### Optional: Babel integration

The CLI is the primary interface.  There is also a Babel entry point for
pipelines that want the transform in-process.  It is not a normal composable
Babel plugin: it owns parsing through `parserOverride`.

```js
import { transformSync } from "@babel/core";
import ctjs from "./src/plugin.js";

const result = transformSync(source, {
  plugins: [ctjs],
  parserOpts: { sourceType: "module" },
  configFile: false,
  babelrc: false,
});

console.log(result.code);
```

These relative imports are for running from this checkout.  If you link the
package locally with `npm link`, use `ctjs` and `ctjs/plugin` instead.

This integration owns parsing because `<if>(x) { ... }` is not valid JavaScript.
For that reason it is best used as the only syntax-extending entry in the
pipeline.  Compile-time APIs can be passed as plugin options:

```js
import { createCollector } from "./src/index.js";

transformSync(source, {
  plugins: [[ctjs, { api: { createCollector } }]],
  parserOpts: { sourceType: "module" },
});
```

Or use the convenience wrapper:

```js
import { transform } from "./src/index.js";

const { code, metadata } = transform(source, {
  pluginOptions: {
    api: { createCollector },
    resolveCompileTimeImport(source, specifiers) {
      return { dataHandler };
    },
  },
});
```

---

## Examples

| Example | What it demonstrates |
| --- | --- |
| [`examples/basic.ctjs`](examples/basic.ctjs) | `<const>`, `<if>/<else>`, `<for>`, `<switch>`, nested compile-time branches |
| [`examples/fn.ctjs`](examples/fn.ctjs) | multi-clause `<fn>`, recursion, runtime dispatcher |
| [`examples/collector/main.ctjs`](examples/collector/main.ctjs) | compile-time modules, `register`, and the `<await>` barrier |

Run them all with `npm run demo`, or compile one with
`npm run compile -- examples/basic.ctjs --stdout`.

---

## Syntax

| Macro | Shape | Meaning |
| --- | --- | --- |
| `<const>` | `<const> name = expr;` | Compile-time binding.  Never downgraded. |
| `<if>` | `<if>(cond) { ... } <else> { ... }` | Compile-time branch, or runtime `if` if `cond` depends on runtime values. |
| `<for>` | `<for>(const x of iterable) { ... }` | Compile-time unrolling, or runtime `for...of`. |
| `<switch>` | `<switch>(value) { case ...: ... default: ... }` | Compile-time case selection, or runtime `switch`.  `case _:` is a wildcard. |
| `<fn>` | `<fn arg> name(pattern, ...rest) { ... }` | Multi-clause function.  Compile-time when all arguments are compile-time; otherwise a runtime dispatcher. |
| `<await>` | `<const> x = <await> api.collectAll();` | Compile-time barrier.  The result must be a compile-time value. |
| `<import>` | `<import> { a, b as c } from "./m.ctjs";` | Compile-time module import. |
| `<export>` | `<export> const x = expr;` / `<export> <fn> ...` | Compile-time export. |

### `<const>`

```js
<const> count = 2 + 3;
<const> config = { debug: false, retries: 3 };

console.log(config.retries + count);
```

`<const>` is not runtime `const`.  It is evaluated by the compiler and its
references are replaced with the value.  A `<const>` that depends on a runtime
value is an error (`CT2001`), not an automatic downgrade.

### `<if>`

```js
<const> debug = false;

<if>(debug) {
  console.log("debug");
} <else> {
  console.log("release");
}
```

If the condition is compile-time, only the selected branch is emitted.  If the
condition depends on a runtime binding, only the `<if>` node is lowered:

```js
function render(enabled) {
  <if>(enabled) {
    <if>(debug) { console.log("debug"); }
  }
}
```

```js
function render(enabled) {
  if (enabled) {
    {
      // inner <if> was still resolved at compile time
    }
  }
}
```

### `<for>`

```js
<for>(name of ["alpha", "beta"]) {
  console.log(name);
}
```

A compile-time iterable is unrolled.  A runtime iterable becomes a normal
`for...of`:

```js
function each(xs) {
  <for>(x of xs) { console.log(x); }
}
```

`break` / `continue` are not supported in an unrolled loop; use a runtime loop
for that case.

### `<switch>`

```js
<const> retries = 3;

<switch>(retries) {
  case 1: console.log("one"); break;
  case 3: console.log("three"); break;
  default: console.log("custom");
}
```

A compile-time discriminant selects one case.  A runtime discriminant becomes a
normal `switch` (strict equality).  `case _:` is treated as `default` when the
switch is lowered to runtime.

> It is called `<switch>` rather than `<match>` because it does not add
> pattern-matching syntax; it stages JavaScript's existing `switch` / `case`
> form.  The name `<match>` is left free for a future pattern-matching feature.

### `<fn>`

`<fn>` is a multi-clause function.  The tag name is the pattern variable used by
the clause; the parameter list contains guards:

```js
<fn arg> label(arg == 1) { return "one"; }
<fn arg> label(arg == 2) { return "two"; }
<fn _> label(_) { return "other"; }

<const> a = label(1); // "one"
console.log(label(2)); // "two"
```

Clauses are tried in source order.  A clause matches when its guard is true.
Guards must be pure and compile-time evaluable when the call is compile-time.

Calls with all compile-time arguments are evaluated by the compiler.  Calls with
runtime arguments emit a runtime dispatcher:

```js
function runtimeLabel(x) {
  return label(x);
}
```

```js
function label(...__ctjs_args) {
  let __ctjs_result;

  __ctjs_result = __ctjs_clause_0__label(...__ctjs_args);
  if (__ctjs_result !== __ctjs_no_match__) return __ctjs_result;

  // ... remaining clauses ...
  throw new Error("No matching <fn> clause for 'label'");
}
```

Compile-time function bodies can use `<const>`, `<if>`, `<for>`, `<switch>`,
`return`, local `let`/`const`, and recursion.  `<await>` is not allowed inside
`<fn>`.

### `<await>` and collectors

`<await>` is a compile-time scheduling point, not runtime `await`:

```js
<export> const dataHandler = createCollector();

<import> { dataHandler } from "./registry.ctjs";
dataHandler.register("a");

<const> values = <await> dataHandler.collectAll();
console.log(values);
```

`dataHandler` is a compile-time API.  Its `register` calls happen while the
compiler evaluates the module's compile-time top level; `<await>` freezes the
collected values into a `<const>`.  The Babel transform requires compile-time
APIs to be synchronous in this version.

---

## Compile-time modules and the barrier

The CLI scans the entry directory (or the `--root` directory), resolves relative
compile-time imports and compiles dependencies first:

```text
registry.ctjs   <export> const dataHandler = createCollector();
a.ctjs          <import> { dataHandler } ...; dataHandler.register("a");
b.ctjs          <import> { dataHandler } ...; dataHandler.register("b");
main.ctjs       <import> { dataHandler } ...; <const> r = <await> dataHandler.collectAll();
```

Before compiling a module that contains `<await>`, the CLI also compiles the
other importers of the same compile-time module (the siblings that call
`register`).  The awaiting module is excluded from its own barrier, so a
`register` before the `<await>` counts and a `register` after it does not.

```text
compile registry
compile a, b          # other importers of registry
compile main          # <await> sees a and b
```

If that ordering cannot be satisfied, the compiler reports a cycle/deadlock
(`CT5002` / `CT5003`) instead of hanging.

Compile-time imports are normally removed from the output.  The one exception is
an imported `<fn>` group used with runtime arguments: the compiler emits a
runtime ESM import for that group and the exporting module emits the runtime
dispatcher.  For ordinary runtime values, use a normal JavaScript `import`.

---

## Stage rules

The compiler follows these stage rules (see
[`docs/semantics.md`](docs/semantics.md)):

1. **Evaluation and inclusion are separate.**  A compile-time expression may not
   read a runtime value.  But code included by a compile-time branch may of
   course reference runtime variables.
2. **Per-node lowering.**  `<if>`, `<for>` and `<switch>` decide their own stage.
   A runtime `if` can contain a compile-time-resolved inner `<if>`.
3. **No automatic downgrade for `<const>`.**  If a `<const>` initializer needs a
   runtime value, that is a stage error.  This keeps the compiler single-pass
   and avoids generating two versions of everything.
4. **`<import>` is static.**  A compile-time import may appear at module top
   level or inside a compile-time branch.  It may not appear inside a runtime
   branch, because the module graph would then depend on a runtime value.
5. **`<fn>` is stage-polymorphic at the call site.**  All compile-time
   arguments mean compile-time evaluation; any runtime argument means a runtime
   dispatcher.  The body itself must be valid in the stage where it is used.
6. **Guards are pure.**  `<fn>` clause guards participate in ordered dispatch and
   must not have side effects.

---

## How it works

Because `<if>` is not valid JavaScript, compilation is:

```text
source with macros
  → preprocess / desugar into valid JS marker calls
  → @babel/parser
  → ctjs compiler (evaluate <const>, choose/emit branches, build <fn> dispatchers)
  → plain JavaScript
```

The preprocessor preserves newlines and records the original line/column in
every marker call, so diagnostics point at the macro the user wrote.  The
compiler keeps a compile-time environment separate from runtime bindings; an
expression is compile-time only when every identifier in it resolves to a
compile-time value or a known pure builtin.

Generated helpers use the reserved prefix `__ctjs_`.

---

## Project layout

```text
src/
  preprocess.js   macro syntax → marker calls
  plugin.js       optional Babel entry (parserOverride + Program visitor)
  compiler.js     compile-time evaluator, stage analysis, code generation
  modules.js      project graph, compile-time imports, barrier ordering
  collector.js    small synchronous collector API
  diagnostics.js  error codes and code frames
  cli.js          `ctjs build`
  index.js        public API
scripts/
  demo.js         compile and run every example
test/             node:test suites
test-utils/       shared test helpers
examples/         runnable examples
docs/             semantics and design notes
.github/          CI, issue templates, PR template
```

---

## Error codes

| Code | Meaning |
| --- | --- |
| `CT1000` | Macro syntax error (missing `(`, malformed `<const>`, etc.) |
| `CT1100` | Source file or compile-time import does not use `.ctjs` |
| `CT2001` | `<const>` depends on a runtime value / assignment to a compile-time constant |
| `CT2002` | Runtime value used where a compile-time value is required |
| `CT2003` | Stage leak (compile-time API or `<await>` in runtime code, `<import>` in a runtime branch) |
| `CT2004` | Identifier is not bound at compile time |
| `CT2005` | Expression is not compile-time evaluable |
| `CT3001` | No matching `<fn>` clause |
| `CT3002` | Compile-time function/API called with a runtime argument |
| `CT3003` | Compile-time function used as a runtime value |
| `CT4001` | `<await>` received a Promise in the synchronous Babel transform |
| `CT5001` | Compile-time module not found / missing export |
| `CT5002` | Compile-time module cycle |
| `CT5003` | Barrier deadlock/cycle |
| `CT9001` | Unsupported construct in this version |

---

## Limitations (v0.1)

This is a working implementation of the core model, not a finished language.

- **Synchronous compile-time APIs.**  `<await>` cannot suspend on a Promise in
  the Babel transform.  The CLI resolves the barrier by compilation order.
- **No AST values.**  Compile-time values are literals, arrays, plain objects,
  regular expressions, dates and functions/closures.  There is no quote/splice
  or AST manipulation.
- **Simple `<const>` bindings.**  Only identifiers, not destructuring patterns.
- **Top-level `<fn>` groups.**  Clause declarations are collected at module top
  level.  Nested `<fn>` declarations are not supported.
- **No macros inside template-literal `${...}` expressions.**  The preprocessor
  deliberately copies template literals verbatim.
- **No source maps.**  The transform changes source shapes; line numbers are
  preserved, but a precise source map is left for a future version.
- **Runtime cross-module `<fn>` calls.**  Imported `<fn>` groups that are used
  with runtime arguments are re-emitted as ordinary ESM imports; the exporting
  module emits the runtime dispatcher.  This works for the CLI's module graph;
  the single-file Babel transform has no module graph to link.
- **No class bodies / object methods in compile-time evaluation.**  Use functions
  and plain data.
- **`<export> <fn>` is a dual-stage export.**  The exporting module emits a
  runtime dispatcher as well as the compile-time group, so the clause body must
  be valid in the runtime stage too.  Use a non-exported group for a helper that
  is compile-time only.
- **No runtime object identity guarantee.**  A compile-time object/array embedded
  in several places is emitted structurally at each use.
- **Guards are assumed pure.**  The compiler does not prove purity of `<fn>`
  guards; keep side effects out of them.
- **No async or I/O capability model.**  Compile-time APIs are whatever the host
  passes in `options.api`; there is no sandbox.

---

## Status and roadmap

**v0.1 is a working prototype.**  The core model is implemented and tested; the
tooling around it is still deliberately small.  This is a personal research
project: issues and PRs are welcome, but the roadmap is exploratory rather than
a support commitment.

Possible next steps, in rough order:

- source maps and better source locations for generated code
- incremental compilation and a cache for compile-time modules
- a stable diagnostics format and more parser recovery
- editor/IDE support for `ctjs` files
- an explicit capability model for compile-time APIs
- a written specification for the stage rules

Not planned: general AST macros, quote/splice, hygiene, or async `<await>` inside
the synchronous Babel transform.

## Contributing

Issues and pull requests are welcome.  Start with
[`CONTRIBUTING.md`](CONTRIBUTING.md); it lists the design constraints and the
test/demo commands.  For the semantics, read
[`docs/semantics.md`](docs/semantics.md).  By participating, you agree to the
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Tests

```bash
npm test        # full suite
npm run demo    # compile and run all examples
```

The suite covers preprocessing, per-node lowering, compile-time values,
`<fn>` guards/rest/recursion/runtime dispatch, stage errors, compile-time
imports/exports and the CLI barrier.

## Origin

The design started as a conversation about staged compile-time evaluation in
JavaScript: explicit stage boundaries, per-node lowering, and a compile-time
module barrier.  This repository is the working implementation of that model.

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md).  Maintainer release notes live in
[`GITHUB.md`](GITHUB.md).

## License

[MIT](LICENSE)
