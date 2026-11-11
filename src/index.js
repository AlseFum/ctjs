import { transformSync } from "@babel/core";
import ctjsPlugin from "./plugin.js";
import { desugarMacros } from "./preprocess.js";
import { Compiler } from "./compiler.js";
import { compileProject, scanModule } from "./modules.js";
import { createCollector } from "./collector.js";

export { ctjsPlugin as plugin, ctjsPlugin as default, desugarMacros, Compiler };
export { compileProject, scanModule };
export { createCollector };
export { formatDiagnostic, CTError, ErrorCodes } from "./diagnostics.js";

/**
 * Transform a single source string.
 *
 * @param {string} source
 * @param {object} [options] Babel plugin options plus Babel transform options.
 * @returns {{code: string, metadata: object, map: object|null}}
 */
export function transform(source, options = {}) {
  const result = transformSync(source, {
    filename: options.filename ?? "<input>.ctjs",
    plugins: [[ctjsPlugin, options.pluginOptions ?? options]],
    parserOpts: {
      sourceType: "module",
      plugins: ["topLevelAwait"],
      ...(options.parserOpts ?? {}),
    },
    configFile: false,
    babelrc: false,
    sourceMaps: options.sourceMaps ?? false,
  });
  return {
    code: result.code,
    metadata: result.metadata,
    map: result.map ?? null,
  };
}
