import * as t from "@babel/types";
import { CTError, ErrorCodes } from "./diagnostics.js";

export function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function describeValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "function") return `function ${value.name || "<anonymous>"}`;
  if (isPlainObject(value)) return "object";
  const ctor = value?.constructor?.name;
  return ctor ? `${ctor}` : typeof value;
}

/**
 * Convert a compile-time value into a Babel expression node.
 * Compile-time API objects and functions intentionally cannot cross into
 * runtime code; that is a stage leak.
 */
export function valueToNode(value, loc = null, seen = new Set()) {
  if (value === undefined) return t.unaryExpression("void", t.numericLiteral(0), true);
  if (value === null) return t.nullLiteral();
  if (typeof value === "string") return t.stringLiteral(value);
  if (typeof value === "boolean") return t.booleanLiteral(value);
  if (typeof value === "number") {
    if (Number.isNaN(value)) return t.identifier("NaN");
    if (value === Infinity) return t.identifier("Infinity");
    if (value === -Infinity) return t.unaryExpression("-", t.identifier("Infinity"), true);
    if (Object.is(value, -0)) return t.unaryExpression("-", t.numericLiteral(0), true);
    return t.numericLiteral(value);
  }
  if (typeof value === "bigint") return t.bigIntLiteral(value.toString());
  if (typeof value === "symbol") {
    throw new CTError(
      ErrorCodes.STAGE_LEAK,
      "A compile-time Symbol cannot be embedded in runtime code",
      loc,
    );
  }
  if (typeof value === "function") {
    throw new CTError(
      ErrorCodes.STAGE_LEAK,
      `Compile-time function '${value.name || "<anonymous>"}' cannot be embedded in runtime code`,
      loc,
      "Call it at compile time or move the logic into a runtime function.",
    );
  }
  if (seen.has(value)) {
    throw new CTError(
      ErrorCodes.STAGE_LEAK,
      "Cannot embed a cyclic compile-time value in runtime code",
      loc,
    );
  }
  if (value instanceof RegExp) {
    return t.regExpLiteral(value.source, value.flags);
  }
  if (value instanceof Date) {
    return t.newExpression(t.identifier("Date"), [t.stringLiteral(value.toISOString())]);
  }
  if (Array.isArray(value)) {
    seen.add(value);
    const node = t.arrayExpression(value.map((item) => valueToNode(item, loc, seen)));
    seen.delete(value);
    return node;
  }
  if (isPlainObject(value)) {
    seen.add(value);
    const props = [];
    for (const [key, item] of Object.entries(value)) {
      const simple = /^[A-Za-z_$][\w$]*$/.test(key) && key !== "__proto__";
      props.push(
        t.objectProperty(
          simple ? t.identifier(key) : t.stringLiteral(key),
          valueToNode(item, loc, seen),
          !simple,
        ),
      );
    }
    seen.delete(value);
    return t.objectExpression(props);
  }
  const ctor = value?.constructor?.name;
  throw new CTError(
    ErrorCodes.STAGE_LEAK,
    `Compile-time value${ctor ? ` (${ctor})` : ""} cannot be embedded in runtime code`,
    loc,
    "Only primitives, arrays, plain objects, RegExp and Date values can cross into runtime code.",
  );
}
