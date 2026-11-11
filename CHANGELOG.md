# Changelog

All notable changes to this project are documented here.

## [0.1.0] - 2026-11-11

### Added

- Optional Babel integration for `<const>`, `<if>/<else>`, `<for>`, `<switch>`, `<fn>`,
  `<await>`, `<import>` and `<export>`.
- Compile-time evaluator with per-node stage lowering.
- Multi-clause `<fn>` with guards, rest parameters, compile-time recursion and a
  runtime dispatcher.
- Compile-time module graph, `<await>` barrier ordering and cycle diagnostics.
- `<switch>` macro (stages the existing `switch` / `case` syntax; `<match>` is
  reserved for a possible future pattern-matching feature).
- `.ctjs` source extension with `.js` output; compile-time imports target
  `.ctjs` and runtime `<fn>` imports are rewritten to `.js`.
- `ctjs` CLI (`build`, `--stdout`, `--out-dir`, `--root`).
- Test suite, runnable examples, and semantics notes.
