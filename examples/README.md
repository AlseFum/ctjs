# Examples

- `basic.ctjs` — `<const>`, `<if>/<else>`, `<for>`, `<switch>`, and a nested
  compile-time `<if>` inside a runtime branch.
- `fn.ctjs` — multi-clause `<fn>`, compile-time recursion, and a runtime
  dispatcher.
- `collector/` — compile-time modules and the `<await>` barrier:
  `registry.ctjs` exports a collector, `a.ctjs` and `b.ctjs` register values, and
  `main.ctjs` awaits the collected result.

```bash
npm run demo

# or compile one example
npm run compile -- examples/basic.ctjs --stdout
npm run compile -- examples/fn.ctjs --stdout
npm run compile -- examples/collector/main.ctjs --out-dir /tmp/ctjs-example
node /tmp/ctjs-example/main.js
```
