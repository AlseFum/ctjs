#!/usr/bin/env node
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileProject } from "./modules.js";
import { formatDiagnostic } from "./diagnostics.js";

const HELP = `ctjs - compile-time macros for JavaScript

Usage:
  ctjs build <entry.ctjs> [--out-dir <dir>] [--root <dir>]
  ctjs build <entry.ctjs> --stdout

Options:
  -o, --out-dir <dir>  Write compiled modules to this directory
  --root <dir>         Scan this project root recursively for barrier siblings
  --stdout             Print the compiled entry module instead of writing files
  -h, --help           Show this help

Source files use the .ctjs extension; compiled output is written as .js.
The CLI understands <const>, <if>/<else>, <for>, <switch>, <fn>, <await>,
<export> and <import>.  Compile-time modules are resolved relative to the
importing file.  The built-in compile-time API is createCollector().
`;

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv[0] !== "build") {
    process.stderr.write(`ctjs: unknown command '${argv[0]}'\n\n${HELP}`);
    return 1;
  }
  const entry = argv[1];
  if (!entry) {
    process.stderr.write("ctjs: missing entry module\n");
    return 1;
  }
  let outDir = null;
  let root = null;
  let stdout = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--out-dir" || argv[i] === "-o") {
      outDir = argv[++i];
    } else if (argv[i] === "--root") {
      root = argv[++i];
    } else if (argv[i] === "--stdout") {
      stdout = true;
    } else {
      process.stderr.write(`ctjs: unknown option '${argv[i]}'\n`);
      return 1;
    }
  }

  try {
    const result = await compileProject({ entry, outDir, root });
    if (stdout) {
      const entryFile = path.resolve(entry);
      process.stdout.write((result.modules.get(entryFile)?.code ?? "") + "\n");
    } else if (outDir) {
      process.stdout.write(
        `compiled ${result.modules.size} module(s) to ${path.resolve(outDir)}\n`,
      );
    } else {
      const entryFile = path.resolve(entry);
      process.stdout.write((result.modules.get(entryFile)?.code ?? "") + "\n");
    }
    return 0;
  } catch (error) {
    if (error.code) {
      if (error.formatted) {
        process.stderr.write((error.formattedMessage ?? error.message) + "\n");
      } else {
        const source = error.source ?? "";
        process.stderr.write(
          formatDiagnostic(error, source, error.filename ?? entry) + "\n",
        );
      }
      return 1;
    }
    process.stderr.write(`${error.stack ?? error}\n`);
    return 1;
  }
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
