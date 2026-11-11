import test from "node:test";
import assert from "node:assert/strict";
import { desugarMacros } from "../src/preprocess.js";

test("desugars const/if/else", () => {
  const { code, macros } = desugarMacros(`<const> x = 1 + 2;\n<if>(x > 2) { a(); } <else> { b(); }`);
  assert.match(code, /const x = __ctjs_macro__\("const", 0, 1, 0, \(1 \+ 2\)\);/);
  assert.match(code, /if \(__ctjs_macro__\("if", 1, 2, 0, \(x > 2\)\)\)/);
  assert.match(code, /else/);
  assert.equal(macros.length, 2);
  assert.equal(macros[0].kind, "const");
});

test("desugars for-of headers", () => {
  const { code } = desugarMacros(`<for>(const x of [1, 2]) { use(x); }`);
  assert.match(code, /for \(const x of __ctjs_macro__\("for", 0, 1, 0, \(\[1, 2\]\)\)\)/);
});

test("desugars <switch> to a marked switch", () => {
  const { code } = desugarMacros(`<switch>(x) { case 1: a(); break; default: b(); }`);
  assert.match(code, /switch \(__ctjs_macro__\("switch", 0, 1, 0, \(x\)\)\)/);
  assert.match(code, /case 1:/);
});

test("desugars fn clause guards", () => {
  const { code } = desugarMacros(`<fn arg> f(arg == 1, ...rest) { return arg; }`);
  assert.match(code, /function __ctjs_clause_0__f\(arg, \.\.\.rest\)/);
  assert.match(code, /__ctjs_clause__\("f", 0, 1, 0, false\)/);
  assert.match(code, /if \(!\(arg == \(1\)\)\) return __ctjs_no_match__;/);
});

test("desugars import/export markers", () => {
  const { code } = desugarMacros(`<export> const x = 1;\n<import> { y as z } from "./m.ctjs";`);
  assert.match(code, /const x = __ctjs_macro__\("export-const", 0, 1, 9, \(1\)\);/);
  assert.match(code, /__ctjs_macro__\("import", 1, 2, 0, "\.\/m\.ctjs", \[\{"imported":"y","local":"z"\}\]\);/);
});

test("does not rewrite macros inside strings, comments or regexes", () => {
  const source = `const s = "<if>(x) {";\n// <const> x = 1;\n/* <for>(x of y) {} */\nconst r = /<switch>/;`;
  const { code, macros } = desugarMacros(source);
  assert.equal(code, source);
  assert.equal(macros.length, 0);
});

test("respects nested delimiters in conditions", () => {
  const { code } = desugarMacros(`<if>(f({ a: [1, 2] })) { x(); }`);
  assert.match(code, /__ctjs_macro__\("if", 0, 1, 0, \(f\(\{ a: \[1, 2\] \}\)\)\)/);
});

test("supports multiple const declarators", () => {
  const { code } = desugarMacros(`<const> a = 1, b = a + 1;`);
  assert.match(code, /const a = __ctjs_macro__\("const", 0, 1, 0, \(1\)\), b = __ctjs_macro__\("const", 1, 1, 0, \(a \+ 1\)\);/);
});

test("reports malformed macro syntax", () => {
  assert.throws(() => desugarMacros(`<if> x`), /Expected '\(' after <if>/);
  assert.throws(() => desugarMacros(`<const> 1 = x;`), /simple identifiers/);
  assert.throws(() => desugarMacros(`<for>(x in y) {}`), /Expected `<for>\(name of iterable\)`/);
});
