import { parse } from "@babel/parser";
import { Compiler } from "./compiler.js";
import { formatDiagnostic } from "./diagnostics.js";
import { desugarMacros } from "./preprocess.js";

/**
 * Babel plugin entry point.
 *
 * The plugin owns parsing because `<if>`, `<const>` and friends are not valid
 * JavaScript.  `parserOverride` desugars them into marker calls and then hands
 * the result to @babel/parser; the Program visitor performs compile-time
 * evaluation and emits plain JavaScript.
 */
export default function ctjsPlugin() {
  return {
    name: "ctjs",
    parserOverride(code, opts, parseFn) {
      const result = desugarMacros(code);
      const ast = parseFn(result.code, opts);
      ast.__ctjsOriginalSource = code;
      ast.__ctjsDesugaredSource = result.code;
      ast.__ctjsMacros = result.macros;
      return ast;
    },
    visitor: {
      Program(path, state) {
        const fileAst = path.hub?.file?.ast ?? path.parent;
        const source =
          fileAst?.__ctjsOriginalSource ??
          state.file?.code ??
          path.hub?.file?.code ??
          "";
        const filename =
          state.file?.opts?.filename ??
          state.filename ??
          "<input>";

        try {
          const compiler = new Compiler(path.node, source, {
            ...state.opts,
            filename,
          });
          const result = compiler.run();
          path.node.body = result.ast.program.body;
          path.node.directives = result.ast.program.directives;
          path.node.sourceType = result.ast.program.sourceType;
          path.node.interpreter = result.ast.program.interpreter;
          // The old Program scope still has bindings from the macro source
          // (for example `<fn>` clause names).  Rebuild it so Babel does not
          // report duplicate declarations for the generated program.
          path.scope.crawl();
          state.file.metadata.ctjs = {
            exports: result.exports,
            groups: [...result.groups.keys()],
            source: filename,
          };
        } catch (error) {
          if (error && error.code) {
            const formatted = formatDiagnostic(error, source, filename);
            error.message = formatDiagnostic(error, source, filename, {
              includeFilename: false,
            });
            error.formattedMessage = formatted;
            error.formatted = true;
            error.source = source;
            error.filename = filename;
          }
          throw error;
        }
      },
    },
  };
}

export { desugarMacros, Compiler };
