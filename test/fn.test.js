import test from "node:test";
import assert from "node:assert/strict";
import { compile, run } from "../test-utils/helpers.js";
import { transform } from "../src/index.js";

test("<fn> selects clauses by guard at compile time", () => {
  const { logs } = run(`
    <fn arg> describe(arg == 1) { return "one"; }
    <fn arg> describe(arg == 2) { return "two"; }
    <fn _> describe(_) { return "other"; }
    console.log(describe(1), describe(2), describe(3));
  `);
  assert.deepEqual(logs, ["one two other"]);
});

test("<fn> supports rest parameters and compile-time recursion", () => {
  const { logs } = run(`
    <fn> fact(n) {
      <if>(n <= 1) { return 1; }
      return n * fact(n - 1);
    }
    <fn> count(first, ...rest) { return rest.length + 1; }
    console.log(fact(5), count("a", "b", "c"));
  `);
  assert.deepEqual(logs, ["120 3"]);
});

test("<fn> bodies can contain <const>, <if> and <for>", () => {
  const { logs } = run(`
    <fn> sum(xs) {
      <const> total = 0;
      let acc = total;
      <for>(x of xs) { acc = acc + x; }
      return acc;
    }
    console.log(sum([1, 2, 3]));
  `);
  assert.deepEqual(logs, ["6"]);
});

test("<switch> works inside a compile-time <fn>", () => {
  const { logs } = run(`
    <fn> label(n) {
      <switch>(n) {
        case 1: return "one";
        default: return "other";
      }
    }
    console.log(label(1), label(2));
  `);
  assert.deepEqual(logs, ["one other"]);
});

test("<fn> lowers to a runtime dispatcher when called with runtime arguments", () => {
  const { code, logs } = run(`
    function call(x) { return classify(x); }
    <fn arg> classify(arg == 1) { return "one"; }
    <fn arg> classify(arg == 2) { return "two"; }
    <fn _> classify(_) { return "other"; }
    console.log(call(1), call(2), call(9));
  `);
  assert.match(code, /function classify\(\.\.\.__ctjs_args\)/);
  assert.deepEqual(logs, ["one two other"]);
});

test("runtime <fn> clause bodies can use runtime <if> and <for>", () => {
  const { code, logs } = run(`
    function run(n, xs) { return classify(n, xs); }
    <fn> classify(n, xs) {
      <if>(n > 0) {
        <for>(x of xs) { console.log(x); }
        return "positive";
      }
      return "negative";
    }
    console.log(run(1, [1, 2]), run(-1, []));
  `);
  assert.match(code, /if \(n > 0\)/);
  assert.match(code, /for \(const x of xs\)/);
  assert.deepEqual(logs, ["1", "2", "positive negative"]);
});

test("<await> is rejected inside <fn>, even when the clause is never called", () => {
  assert.throws(
    () => compile(`<fn> f(x) { return <await> x; }`),
    /<await> is not allowed inside <fn>/,
  );
});

test("<import> is rejected inside <fn>", () => {
  assert.throws(
    () => compile(`<fn> f(x) { <import> { y } from "./y.ctjs"; return x; }`),
    /<import> is not allowed inside <fn>/,
  );
});

test("<fn> clauses are rejected outside module top level", () => {
  assert.throws(
    () => compile(`function outer() { <fn> inner(x) { return x; } }`),
    /<fn> clauses are only supported at module top level/,
  );
});

test("a runtime <fn> clause cannot depend on a runtime parameter with <const>", () => {
  assert.throws(
    () =>
      compile(`
        function run(n) { return classify(n); }
        <fn> classify(n) { <const> x = n + 1; return x; }
      `),
    /<const> 'x' depends on a runtime value/,
  );
});

test("<fn> groups can be exported and imported at compile time", () => {
  const library = `
    <export> <fn> add(a, b) { return a + b; }
    <export> const version = "1.0";
  `;
  const lib = compile(library);
  // Re-run through the plugin with a resolver to exercise the import path.
  const libResult = transform(library);
  const app = transform(
    `<import> { add, version } from "./lib.ctjs";\n<const> sum = add(2, 3);\nconsole.log(sum, version);`,
    {
      pluginOptions: {
        resolveCompileTimeImport() {
          return Object.fromEntries(libResult.metadata.ctjs.exports);
        },
      },
    },
  );
  assert.match(app.code, /console\.log\(5, "1\.0"\)/);
  assert.equal(lib.includes("__ctjs_macro__"), false);
});
