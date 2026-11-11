#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileProject } from "../src/modules.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXAMPLES = [
  "examples/basic.ctjs",
  "examples/fn.ctjs",
  "examples/collector/main.ctjs",
];

let failed = false;

for (const example of EXAMPLES) {
  const entry = path.join(ROOT, example);
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "ctjs-demo-"));
  try {
    const result = await compileProject({ entry, outDir });
    const output = path.join(
      outDir,
      path.basename(entry).replace(/\.ctjs$/, ".js"),
    );
    const stdout = execFileSync(process.execPath, [output], {
      encoding: "utf8",
    });
    console.log(`\n=== ${example} ===`);
    console.log(`compiled ${result.modules.size} module(s)`);
    console.log(stdout.trimEnd());
  } catch (error) {
    failed = true;
    console.error(`\n=== ${example} ===`);
    console.error(error?.formattedMessage ?? error?.stack ?? String(error));
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
}

if (failed) process.exitCode = 1;
