import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import { transformSync } from "@babel/core";
import ctjsPlugin from "./plugin.js";
import { MARKER, desugarMacros } from "./preprocess.js";
import { CTError, ErrorCodes } from "./diagnostics.js";
import { createCollector } from "./collector.js";

const traverse = traverseModule.default ?? traverseModule;

/**
 * Statically scan a module for compile-time imports and <await>.
 * The macro syntax is desugared first so the scan uses the same parser as the
 * transform, rather than a brittle regular expression.
 */
export function scanModule(source, filename = "<input>") {
  const { code } = desugarMacros(source);
  const ast = parse(code, { sourceType: "module", plugins: ["topLevelAwait"] });
  const imports = new Map();
  let hasAwait = false;

  traverse(ast, {
    CallExpression(p) {
      if (!p.node.callee || p.node.callee.name !== MARKER) return;
      const kind = p.node.arguments[0]?.value;
      if (kind === "await") hasAwait = true;
      if (kind !== "import") return;
      const sourceArg = p.node.arguments[4];
      const specsArg = p.node.arguments[5];
      if (!sourceArg || sourceArg.type !== "StringLiteral") return;
      const specs = [];
      if (specsArg?.type === "ArrayExpression") {
        for (const element of specsArg.elements) {
          if (element?.type !== "ObjectExpression") continue;
          const imported = element.properties.find(
            (prop) =>
              prop.type === "ObjectProperty" &&
              ((prop.key.type === "Identifier" && prop.key.name === "imported") ||
                (prop.key.type === "StringLiteral" && prop.key.value === "imported")),
          )?.value?.value;
          const local = element.properties.find(
            (prop) =>
              prop.type === "ObjectProperty" &&
              ((prop.key.type === "Identifier" && prop.key.name === "local") ||
                (prop.key.type === "StringLiteral" && prop.key.value === "local")),
          )?.value?.value;
          if (imported && local) specs.push({ imported, local });
        }
      }
      if (!imports.has(sourceArg.value)) imports.set(sourceArg.value, []);
      imports.get(sourceArg.value).push(...specs);
    },
  });

  return { imports, hasAwait, filename };
}

export async function resolveModule(fromFile, specifier) {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    throw new CTError(
      ErrorCodes.MODULE_NOT_FOUND,
      `Compile-time <import> must be a relative path, got '${specifier}'`,
      null,
      "The ctjs CLI only resolves local compile-time modules in this version.",
    );
  }
  if (!specifier.endsWith(".ctjs")) {
    throw new CTError(
      ErrorCodes.INVALID_EXTENSION,
      `Compile-time <import> must target a .ctjs file, got '${specifier}'`,
      null,
      "Use './module.ctjs'.  Runtime output is emitted as .js.",
    );
  }
  const candidate = path.resolve(path.dirname(fromFile), specifier);
  try {
    const stat = await fs.stat(candidate);
    if (stat.isFile()) return candidate;
  } catch {
    // fall through to the diagnostic below
  }
  throw new CTError(
    ErrorCodes.MODULE_NOT_FOUND,
    `Cannot resolve compile-time module '${specifier}' from '${fromFile}'`,
    null,
  );
}

async function listModuleFiles(root, outDir, recursive = false) {
  const out = [];
  const skip = new Set([
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "dist",
    "build",
    "coverage",
    ".next",
    "out",
  ]);
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (outDir && path.resolve(full).startsWith(path.resolve(outDir) + path.sep)) continue;
      if (entry.isDirectory()) {
        if (recursive && !skip.has(entry.name)) await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ctjs")) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

/**
 * Compile an entry module and every reachable compile-time import.
 *
 * Compile-time modules form a graph.  Modules are compiled after their
 * dependencies.  A module containing <await> also forces all sibling modules
 * that import the same dependency (i.e. the other importers of a collector) to
 * compile first, which is the practical form of the "wait for all importers"
 * barrier in a synchronous compiler.
 */
export async function compileProject(options) {
  const entry = path.resolve(options.entry);
  if (!entry.endsWith(".ctjs")) {
    throw new CTError(
      ErrorCodes.INVALID_EXTENSION,
      `Entry file must use the .ctjs extension: '${entry}'`,
      null,
      "Rename the source to .ctjs; compiled output is written as .js.",
    );
  }
  const api = { createCollector, ...(options.api ?? {}) };
  const scanned = new Map();
  const importers = new Map();
  const state = new Map(); // file -> "compiling" | "done"
  const compiled = new Map();
  const stack = [];

  async function scan(file, optional = false) {
    if (scanned.has(file)) return;
    let source;
    try {
      source = await fs.readFile(file, "utf8");
    } catch (error) {
      throw new CTError(
        ErrorCodes.MODULE_NOT_FOUND,
        `Cannot read '${file}': ${error.message}`,
        null,
      );
    }
    if (optional && file !== entry && !/<import\b/.test(source)) {
      return;
    }
    let info;
    try {
      info = scanModule(source, file);
    } catch (error) {
      error.source ??= source;
      error.filename ??= file;
      throw error;
    }
    info.source = source;
    info.dependencies = new Map();
    for (const spec of info.imports.keys()) {
      const resolved = await resolveModule(file, spec);
      info.dependencies.set(spec, resolved);
      if (!importers.has(resolved)) importers.set(resolved, new Set());
      importers.get(resolved).add(file);
    }
    scanned.set(file, info);
    for (const dep of info.dependencies.values()) {
      await scan(dep);
    }
  }

  function makeResolver(file, info) {
    return (specifier, specs) => {
      const depFile = info.dependencies.get(specifier);
      if (!depFile) {
        throw new CTError(
          ErrorCodes.MODULE_NOT_FOUND,
          `No resolved compile-time module for '${specifier}'`,
          null,
        );
      }
      const dep = compiled.get(depFile);
      if (!dep) {
        throw new CTError(
          ErrorCodes.BARRIER_DEADLOCK,
          `Module '${file}' needs '${depFile}' before it has completed`,
          null,
          `Compile-time import cycle: ${[...stack, file, depFile].join(" -> ")}`,
        );
      }
      const out = {};
      for (const spec of specs) {
        if (!dep.exports.has(spec.imported)) {
          throw new CTError(
            ErrorCodes.MODULE_NOT_FOUND,
            `Compile-time module '${specifier}' does not export '${spec.imported}'`,
            null,
          );
        }
        out[spec.imported] = dep.exports.get(spec.imported);
      }
      return out;
    };
  }

  async function compile(file) {
    if (state.get(file) === "done") return;
    if (state.get(file) === "compiling") {
      throw new CTError(
        ErrorCodes.BARRIER_DEADLOCK,
        `Compile-time cycle detected: ${[...stack, file].join(" -> ")}`,
        null,
        "A module cannot await a barrier that depends on itself.",
      );
    }
    state.set(file, "compiling");
    stack.push(file);
    const info = scanned.get(file);
    try {
      // Dependencies must be available before this module can evaluate its
      // compile-time imports.
      for (const dep of info.dependencies.values()) {
        await compile(dep);
      }

      // Barrier ordering: before a module that contains <await>, make sure the
      // other importers of its dependencies have completed their compile-time
      // top level (their register calls).
      if (info.hasAwait) {
        for (const dep of info.dependencies.values()) {
          for (const sibling of importers.get(dep) ?? []) {
            if (sibling === file) continue;
            if (state.get(sibling) !== "done") {
              await compile(sibling);
            }
          }
        }
      }

      let result;
      try {
        result = transformSync(info.source, {
          filename: file,
          plugins: [[ctjsPlugin, { resolveCompileTimeImport: makeResolver(file, info), api }]],
          parserOpts: { sourceType: "module", plugins: ["topLevelAwait"] },
          configFile: false,
          babelrc: false,
        });
      } catch (error) {
        error.source ??= info.source;
        error.filename ??= file;
        throw error;
      }
      compiled.set(file, {
        file,
        code: result.code,
        exports: result.metadata.ctjs?.exports ?? new Map(),
        source: info.source,
      });
      state.set(file, "done");
    } finally {
      stack.pop();
      if (state.get(file) !== "done") state.delete(file);
    }
  }

  await scan(entry);
  const scanRoot = options.root ? path.resolve(options.root) : path.dirname(entry);
  for (const file of await listModuleFiles(
    scanRoot,
    options.outDir,
    Boolean(options.root),
  )) {
    if (!scanned.has(file)) await scan(file, true);
  }
  await compile(entry);

  if (options.outDir) {
    const root = path.dirname(entry);
    let emittedEsm = false;
    for (const [file, mod] of compiled) {
      let rel = path.relative(root, file);
      if (rel.startsWith("..")) rel = path.basename(file);
      rel = rel.replace(/\.ctjs$/, ".js");
      const target = path.join(options.outDir, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, mod.code + "\n", "utf8");
      if (/^\s*(?:import|export)\s/m.test(mod.code)) emittedEsm = true;
    }
    if (emittedEsm) {
      const packageFile = path.join(options.outDir, "package.json");
      try {
        await fs.access(packageFile);
      } catch {
        await fs.writeFile(
          packageFile,
          JSON.stringify({ type: "module" }, null, 2) + "\n",
          "utf8",
        );
      }
    }
  }

  return { entry, modules: compiled };
}

export default compileProject;
