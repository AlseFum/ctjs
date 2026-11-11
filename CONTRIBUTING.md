# Contributing

ctjs is an experimental compiler.  Small, well-tested changes are much more
useful than broad syntax additions.

## Setup

```bash
git clone <your-fork-url>
cd ctjs
npm ci
npm test
npm run demo
```

Requires Node `^22.18.0` or `>=24.11.0` (Babel 8's engine range).

## Where things live

| Path | Responsibility |
| --- | --- |
| `src/preprocess.js` | macro syntax → valid JS marker calls |
| `src/plugin.js` | optional Babel entry (`parserOverride` + Program visitor) |
| `src/compiler.js` | compile-time evaluator, stage analysis, codegen |
| `src/modules.js` | project graph, compile-time imports, barrier ordering |
| `src/cli.js` | `ctjs build` |
| `src/diagnostics.js` | error codes and code frames |
| `test/` | `node:test` suites |

## Design constraints (v0.1)

Please do not add these without a design discussion first:

- compile-time AST values, quote/splice, or general macro expansion
- automatic `<const>` downgrade to runtime `const`
- async `<await>` in the Babel transform
- `<await>`, `<import>` or `<export>` inside `<fn>`
- nested `<fn>` declarations
- source-map claims without an implementation

The stage rules are documented in [`docs/semantics.md`](docs/semantics.md).

## Tests

```bash
npm test              # full suite
npm run demo          # compile and run all examples
npm run compile -- examples/basic.ctjs --stdout
```

Add a regression test for every bug fix.  For parser/preprocessor changes, add a
case that covers strings, comments and nested delimiters.

## Pull requests

- Keep the diff focused.
- Explain the semantic decision, not just the code change.
- Update `README.md` and `docs/semantics.md` when behavior changes.
- Fill in the PR checklist.
