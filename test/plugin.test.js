import test from "node:test";
import assert from "node:assert/strict";
import { compile, run } from "../test-utils/helpers.js";

test("<const> evaluates and inlines compile-time values", () => {
  const { code, logs } = run(`
    <const> n = 2 + 3;
    <const> name = "ct";
    console.log(name, n * 2);
  `);
  assert.equal(code.includes("<const>"), false);
  assert.deepEqual(logs, ["ct 10"]);
});

test("<if> selects a compile-time branch and removes the other", () => {
  const { code, logs } = run(`
    <const> debug = false;
    <if>(debug) { console.log("debug"); } <else> { console.log("release"); }
  `);
  assert.equal(code.includes("debug\""), false);
  assert.deepEqual(logs, ["release"]);
});

test("<if> lowers to runtime if when the condition depends on a runtime value", () => {
  const { code } = run(`
    function f(a) { <if>(a) { console.log("yes"); } <else> { console.log("no"); } }
    f(true); f(false);
  `);
  assert.match(code, /if \(a\)/);
  assert.equal(code.includes("__ctjs_macro__"), false);
});

test("nested <if> can be compile-time inside a runtime branch", () => {
  const { code, logs } = run(`
    <const> inner = true;
    function f(a) {
      <if>(a) {
        <if>(inner) { console.log("inner"); } <else> { console.log("no inner"); }
      }
    }
    f(true); f(false);
  `);
  assert.match(code, /if \(a\)/);
  assert.deepEqual(logs, ["inner"]);
});

test("<for> unrolls a compile-time iterable", () => {
  const { code, logs } = run(`
    <for>(x of [1, 2, 3]) { console.log(x); }
  `);
  assert.equal(code.includes("for ("), false);
  assert.deepEqual(logs, ["1", "2", "3"]);
});

test("<for> lowers to a runtime for-of for a runtime iterable", () => {
  const { code } = run(`
    function f(xs) { <for>(x of xs) { console.log(x); } }
    f([1, 2]);
  `);
  assert.match(code, /for \(const x of xs\)/);
});

test("<switch> selects a compile-time case", () => {
  const { code, logs } = run(`
    <const> which = 2;
    <switch>(which) {
      case 1: console.log("one"); break;
      case 2: console.log("two"); break;
      default: console.log("other");
    }
  `);
  assert.equal(code.includes("switch"), false);
  assert.deepEqual(logs, ["two"]);
});

test("<switch> lowers to a runtime switch", () => {
  const { code, logs } = run(`
    function f(x) {
      <switch>(x) {
        case 1: return "one";
        case 2: return "two";
        default: return "other";
      }
    }
    console.log(f(1), f(2), f(3));
  `);
  assert.match(code, /switch \(x\)/);
  assert.deepEqual(logs, ["one two other"]);
});

test("runtime <switch> supports _ as a wildcard case", () => {
  const { logs } = run(`
    function f(x) {
      <switch>(x) {
        case 1: return "one";
        case _: return "other";
      }
    }
    console.log(f(1), f(9));
  `);
  assert.deepEqual(logs, ["one other"]);
});


test("runtime logical expressions are preserved", () => {
  const { code, logs } = run(`
    <const> enabled = true;
    function f(x) { return enabled && x; }
    console.log(f("yes"), f(""));
  `);
  assert.match(code, /true && x/);
  assert.deepEqual(logs, ["yes "]);
});

test("object shorthand is expanded when a compile-time value is inlined", () => {
  const { code, logs } = run(`
    <const> x = 1;
    const o = { x };
    console.log(o.x);
  `);
  assert.match(code, /x: 1/);
  assert.deepEqual(logs, ["1"]);
});

test("runtime builtin member calls are not folded or rewritten", () => {
  const code = compile(`Math.random(); console.log(Math.max(1, 2));`);
  assert.match(code, /Math\.random\(\)/);
  assert.match(code, /Math\.max\(1, 2\)/);
});

test("compile-time closures work with array methods", () => {
  const { logs } = run(`
    <const> doubled = [1, 2, 3].map((x) => x * 2);
    <const> total = [1, 2, 3].reduce((a, b) => a + b, 0);
    console.log(doubled.join(","), total);
  `);
  assert.deepEqual(logs, ["2,4,6 6"]);
});

test("compile-time member access is inlined", () => {
  const { logs } = run(`
    <const> cfg = { nested: { value: 7 } };
    console.log(cfg.nested.value);
  `);
  assert.deepEqual(logs, ["7"]);
});

test("class property and method bodies are compiled", () => {
  const { code, logs } = run(`
    class A {
      x = 1;
      m() { <if>(true) { return this.x; } }
    }
    console.log(new A().m());
  `);
  assert.match(code, /class A/);
  assert.equal(code.includes("__ctjs_"), false);
  assert.deepEqual(logs, ["1"]);
});

test("object method bodies are compiled", () => {
  const { code, logs } = run(`
    function f(x) {
      const o = { m(a) { <if>(a) { return x; } return 0; } };
      return o.m(1) + o.m(0);
    }
    console.log(f(3));
  `);
  assert.match(code, /if \(a\)/);
  assert.equal(code.includes("__ctjs_"), false);
  assert.deepEqual(logs, ["3"]);
});

test("<else> <if> is lowered as else-if", () => {
  const { logs } = run(`
    function f(x) {
      <if>(x === 1) { return "one"; } <else> <if>(x === 2) { return "two"; }
      return "other";
    }
    console.log(f(1), f(2), f(3));
  `);
  assert.deepEqual(logs, ["one two other"]);
});

test("strings, comments and regexes are not rewritten", () => {
  const code = compile(`
    const s = "<if>(x) { not a macro }";
    // <const> nope = 1;
    /* <for>(x of y) {} */
    const r = /<const>/;
    console.log(s, r);
  `);
  assert.match(code, /"<if>\(x\) \{ not a macro \}"/);
  assert.match(code, /\/<const>\//);
});

test("<const> with a runtime value is a stage error", () => {
  assert.throws(
    () => compile(`function f(a) { <const> x = a; }`),
    /<const> 'x' depends on a runtime value/,
  );
});

test("assigning to a compile-time binding is an error", () => {
  assert.throws(() => compile(`<const> x = 1; x = 2;`), /Cannot assign to compile-time binding/);
});

test("<await> in a runtime branch is a stage error", () => {
  assert.throws(
    () => compile(`function f(a) { <if>(a) { <const> x = <await> foo(); } }`),
    /<await> cannot appear inside a runtime branch/,
  );
});

test("compile-time API calls are evaluated and removed", () => {
  const values = [];
  const api = {
    record(v) {
      values.push(v);
      return v;
    },
  };
  const code = compile(
    `
    record("a");
    <const> x = record("b");
    console.log(x);
  `,
    { api },
  );
  assert.equal(code.includes("record"), false);
  assert.deepEqual(values, ["a", "b"]);
});

test("a compile-time API call inside a runtime branch is rejected", () => {
  const api = { register() {} };
  assert.throws(
    () =>
      compile(
        `function f(a) { <if>(a) { api.register("x"); } }`,
        { api: { api } },
      ),
    /compile-time API call cannot appear inside a runtime branch/,
  );
});

test("<await> inside a runtime branch is rejected even in a compile-time API call", () => {
  const api = { call() {} };
  assert.throws(
    () =>
      compile(
        `function g(a) { <if>(a) { api.call(<await> foo()); } }`,
        { api: { api } },
      ),
    /<await> cannot appear inside a runtime branch/,
  );
});

test("compile-time API calls with runtime arguments are rejected", () => {
  const api = { record() {} };
  assert.throws(
    () => compile(`function f(a) { record(a); }`, { api }),
    /Compile-time API call is not fully compile-time/,
  );
});
