import { codeFrameColumns } from "@babel/code-frame";

/**
 * A compile-time diagnostic.  `loc` uses Babel/source locations:
 * `{ line, column }` with a 0-based column.
 */
export class CTError extends Error {
  constructor(code, message, loc = null, hint = null) {
    super(message);
    this.name = "CTError";
    this.code = code;
    this.loc = loc;
    this.hint = hint;
  }
}

export function diagnostic(code, message, loc, hint) {
  return new CTError(code, message, loc, hint);
}

export function formatDiagnostic(
  error,
  source,
  filename = "<input>",
  options = {},
) {
  const loc = error.loc;
  const includeFilename = options.includeFilename !== false;
  const location = loc ? `${loc.line}:${(loc.column ?? 0) + 1}` : "";
  const prefix = includeFilename
    ? `${filename}${location ? `:${location}` : ""}`
    : location;
  let out = `${prefix ? `${prefix}  ` : ""}${error.code ?? "CT0000"}  ${error.message}`;
  if (loc && source) {
    try {
      out += "\n" + codeFrameColumns(source, { start: loc }, { highlightCode: false });
    } catch {
      // Ignore frame failures; the location line is still useful.
    }
  }
  if (error.hint) out += `\n  hint: ${error.hint}`;
  return out;
}

export const ErrorCodes = Object.freeze({
  SYNTAX: "CT1000",
  INVALID_EXTENSION: "CT1100",
  RUNTIME_IN_CONST: "CT2001",
  RUNTIME_IN_COMPILE_TIME: "CT2002",
  STAGE_LEAK: "CT2003",
  UNKNOWN_IDENTIFIER: "CT2004",
  NOT_COMPILE_TIME: "CT2005",
  NO_CLAUSE: "CT3001",
  RUNTIME_ARG_IN_COMPILE_TIME: "CT3002",
  COMPILE_TIME_CALL_IN_RUNTIME: "CT3003",
  AWAIT_ASYNC: "CT4001",
  MODULE_NOT_FOUND: "CT5001",
  MODULE_CYCLE: "CT5002",
  BARRIER_DEADLOCK: "CT5003",
  UNSUPPORTED: "CT9001",
});
