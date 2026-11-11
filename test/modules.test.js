import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { compileProject, scanModule } from "../src/modules.js";

async function project(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ctjs-"));
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, source, "utf8");
  }
  return dir;
}

test("scanModule finds compile-time imports and <await>", () => {
  const info = scanModule(`
    <import> { a, b as c } from "./x.ctjs";
    <const> r = <await> a.collectAll();
  `);
  assert.equal(info.hasAwait, true);
  assert.deepEqual([...info.imports.keys()], ["./x.ctjs"]);
  assert.deepEqual(info.imports.get("./x.ctjs"), [
    { imported: "a", local: "a" },
    { imported: "b", local: "c" },
  ]);
});

test("compileProject resolves .ctjs modules and the barrier", async () => {
  const dir = await project({
    "registry.ctjs": `<export> const dataHandler = createCollector();\n`,
    "a.ctjs": `<import> { dataHandler } from "./registry.ctjs";\ndataHandler.register("a");\n`,
    "b.ctjs": `<import> { dataHandler } from "./registry.ctjs";\ndataHandler.register("b");\n`,
    "main.ctjs": `<import> { dataHandler } from "./registry.ctjs";\ndataHandler.register("main");\n<const> results = <await> dataHandler.collectAll();\nconsole.log(results.sort().join(","));\n`,
  });
  const outDir = path.join(dir, "out");
  const result = await compileProject({ entry: path.join(dir, "main.ctjs"), outDir });
  const main = result.modules.get(path.join(dir, "main.ctjs"));
  assert.ok(main);
  assert.match(main.code, /console\.log\("a,b,main"\)/);

  const output = await import(pathToFileURL(path.join(outDir, "main.js")).href);
  assert.ok(output);
});

test("compileProject rejects a .js entry", async () => {
  const dir = await project({ "main.js": `console.log("<const>");\n` });
  await assert.rejects(
    () => compileProject({ entry: path.join(dir, "main.js") }),
    /Entry file must use the \.ctjs extension/,
  );
});

test("compileProject rejects .js compile-time imports", async () => {
  const dir = await project({
    "registry.ctjs": `<export> const dataHandler = createCollector();\n`,
    "main.ctjs": `<import> { dataHandler } from "./registry.js";\n`,
  });
  await assert.rejects(
    () => compileProject({ entry: path.join(dir, "main.ctjs") }),
    /must target a \.ctjs file/,
  );
});

test("compileProject reports compile-time import cycles", async () => {
  const dir = await project({
    "a.ctjs": `<import> { b } from "./b.ctjs";\n<export> const a = b + 1;\n`,
    "b.ctjs": `<import> { a } from "./a.ctjs";\n<export> const b = a + 1;\n`,
    "main.ctjs": `<import> { a } from "./a.ctjs";\nconsole.log(a);\n`,
  });
  await assert.rejects(
    () => compileProject({ entry: path.join(dir, "main.ctjs") }),
    /Compile-time cycle|BARRIER|needs/,
  );
});

test("imported <fn> groups emit a .js runtime import", async () => {
  const dir = await project({
    "lib.ctjs": `<export> <fn> add(a, b) { return a + b; }\n`,
    "main.ctjs": `<import> { add } from "./lib.ctjs";\nfunction run(x) { return add(x, 1); }\nconsole.log(run(2));\n`,
  });
  const outDir = path.join(dir, "out");
  const result = await compileProject({ entry: path.join(dir, "main.ctjs"), outDir });
  const main = result.modules.get(path.join(dir, "main.ctjs"));
  const lib = result.modules.get(path.join(dir, "lib.ctjs"));
  assert.match(main.code, /import \{ add \} from "\.\/lib\.js"/);
  assert.match(lib.code, /export function add/);
  const output = execFileSync(process.execPath, [path.join(outDir, "main.js")], {
    encoding: "utf8",
  }).trim();
  assert.equal(output, "3");
});
