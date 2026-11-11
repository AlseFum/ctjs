import * as t from "@babel/types";
import { CTError, ErrorCodes } from "./diagnostics.js";
import { describeValue, isPlainObject, valueToNode } from "./values.js";
import { CLAUSE_MARKER, MARKER, NO_MATCH } from "./preprocess.js";

const SAFE_MATH = Object.freeze({
  E: Math.E,
  LN10: Math.LN10,
  LN2: Math.LN2,
  LOG10E: Math.LOG10E,
  LOG2E: Math.LOG2E,
  PI: Math.PI,
  SQRT1_2: Math.SQRT1_2,
  SQRT2: Math.SQRT2,
  abs: Math.abs,
  acos: Math.acos,
  acosh: Math.acosh,
  asin: Math.asin,
  asinh: Math.asinh,
  atan: Math.atan,
  atan2: Math.atan2,
  atanh: Math.atanh,
  cbrt: Math.cbrt,
  ceil: Math.ceil,
  clz32: Math.clz32,
  cos: Math.cos,
  cosh: Math.cosh,
  exp: Math.exp,
  expm1: Math.expm1,
  floor: Math.floor,
  fround: Math.fround,
  hypot: Math.hypot,
  imul: Math.imul,
  log: Math.log,
  log1p: Math.log1p,
  log10: Math.log10,
  log2: Math.log2,
  max: Math.max,
  min: Math.min,
  pow: Math.pow,
  round: Math.round,
  sign: Math.sign,
  sin: Math.sin,
  sinh: Math.sinh,
  sqrt: Math.sqrt,
  tan: Math.tan,
  tanh: Math.tanh,
  trunc: Math.trunc,
});

class NotCompileTime extends Error {
  constructor(reason = "not a compile-time value") {
    super(reason);
    this.name = "NotCompileTime";
  }
}

class Env {
  constructor(parent = null) {
    this.parent = parent;
    this.bindings = new Map();
  }

  declare(name, binding) {
    this.bindings.set(name, binding);
    return binding;
  }

  lookup(name) {
    for (let env = this; env; env = env.parent) {
      const binding = env.bindings.get(name);
      if (binding) return binding;
    }
    return null;
  }

  child() {
    return new Env(this);
  }
}

class CTFunctionGroup {
  constructor(name, clauses, owner = null) {
    this.name = name;
    this.clauses = clauses;
    this.owner = owner;
    this.exported = clauses.some((clause) => clause.exported);
    this.usedRuntime = false;
    this.kind = "ct-function-group";
  }
}

class CTClosure {
  constructor(compiler, node, env) {
    this.compiler = compiler;
    this.node = node;
    this.env = env;
    this.kind = "ct-closure";
  }

  call(args, loc) {
    return this.compiler.callClosure(this, args, loc);
  }
}

function cloneDirectives(node) {
  return (node?.directives ?? []).map((directive) => t.cloneNode(directive));
}

function markerOf(node) {
  if (!t.isCallExpression(node)) return null;
  if (!t.isIdentifier(node.callee, { name: MARKER })) return null;
  const [kind, id, line, column, ...rest] = node.arguments;
  if (!t.isStringLiteral(kind) || !t.isNumericLiteral(id)) return null;
  return {
    kind: kind.value,
    id: id.value,
    loc: {
      line: line?.value ?? 1,
      column: column?.value ?? 0,
    },
    args: rest,
    node,
  };
}

function clauseMarkerOf(node) {
  if (!t.isFunctionDeclaration(node) || node.body.body.length === 0) return null;
  const first = node.body.body[0];
  if (!t.isExpressionStatement(first)) return null;
  const call = first.expression;
  if (!t.isCallExpression(call) || !t.isIdentifier(call.callee, { name: CLAUSE_MARKER })) {
    return null;
  }
  const [group, id, line, column, exported] = call.arguments;
  if (!t.isStringLiteral(group) || !t.isNumericLiteral(id)) return null;
  return {
    group: group.value,
    id: id.value,
    loc: {
      line: line?.value ?? 1,
      column: column?.value ?? 0,
    },
    exported: t.isBooleanLiteral(exported) ? exported.value : false,
  };
}

function isNoMatchReturn(statement) {
  if (!t.isReturnStatement(statement) || !statement.argument) return false;
  return t.isIdentifier(statement.argument, { name: NO_MATCH });
}

function guardOfClause(node) {
  // Preprocessor shape:
  //   __ctjs_clause__(...);
  //   if (!(guard)) return __ctjs_no_match__;
  //   ...body...
  const body = node.body.body;
  const guardStmt = body[1];
  if (!t.isIfStatement(guardStmt)) return { guard: null, bodyStart: 1 };
  const test = guardStmt.test;
  if (
    t.isUnaryExpression(test, { operator: "!" }) &&
    isNoMatchReturn(guardStmt.consequent) &&
    !guardStmt.alternate
  ) {
    return { guard: test.argument, bodyStart: 2 };
  }
  return { guard: null, bodyStart: 1 };
}

function boundNames(pattern, out = []) {
  if (t.isIdentifier(pattern)) {
    out.push(pattern.name);
  } else if (t.isObjectPattern(pattern)) {
    for (const prop of pattern.properties) {
      if (t.isRestElement(prop)) boundNames(prop.argument, out);
      else boundNames(prop.value, out);
    }
  } else if (t.isArrayPattern(pattern)) {
    for (const element of pattern.elements) {
      if (element) boundNames(element, out);
    }
  } else if (t.isRestElement(pattern)) {
    boundNames(pattern.argument, out);
  } else if (t.isAssignmentPattern(pattern)) {
    boundNames(pattern.left, out);
  }
  return out;
}

function isThenable(value) {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof value.then === "function"
  );
}

function isIterable(value) {
  return (
    value !== null &&
    value !== undefined &&
    (typeof value === "string" || typeof value[Symbol.iterator] === "function")
  );
}

export class Compiler {
  constructor(ast, source, options = {}) {
    this.ast = ast;
    this.source = source;
    this.options = options;
    this.filename = options.filename ?? "<input>";
    this.global = new Env();
    this.groups = new Map();
    this.exports = new Map();
    this.diagnostics = [];
    this.callDepth = 0;
    this.maxCallDepth = options.maxCompileTimeDepth ?? 512;
    this.helpers = new Set();
    this.imported = new Set();
    this.ctImports = new Map();
    this.runtimeImports = new Map();
    this.runtimeDepth = 0;
    this.fnDepth = 0;

    const api = options.api ?? {};
    for (const [name, value] of Object.entries(api)) {
      this.global.declare(name, { type: "ct", value });
    }
  }

  run() {
    const program = this.ast.program ?? this.ast;
    const statements = program.body.slice();

    // Compile-time imports are hoisted for the module, like ESM imports.
    const remaining = [];
    const importStatements = new Set();
    for (const stmt of statements) {
      const marker = t.isExpressionStatement(stmt) ? markerOf(stmt.expression) : null;
      if (marker?.kind === "import") {
        this.importCompileTime(marker, this.global);
        importStatements.add(stmt);
      } else {
        remaining.push(stmt);
      }
    }

    // Collect <fn> clause groups before compiling calls (function declarations
    // are hoisted in JavaScript).
    const body = [];
    for (const stmt of remaining) {
      const meta = clauseMarkerOf(stmt);
      if (meta) {
        this.addClause(stmt, meta);
      } else {
        body.push(stmt);
      }
    }

    for (const group of this.groups.values()) {
      if (group.exported) this.exports.set(group.name, group);
    }

    const out = [];
    for (const stmt of body) {
      this.compileStatement(stmt, this.global, out, { runtime: false, topLevel: true });
    }

    const runtimeGroups = [...this.groups.values()].filter(
      (group) => group.usedRuntime || group.exported,
    );
    if (runtimeGroups.length > 0) this.helpers.add("noMatch");

    const importDecls = [...this.runtimeImports.entries()].map(([local, spec]) =>
      t.importDeclaration(
        [t.importSpecifier(t.identifier(local), t.identifier(spec.imported))],
        t.stringLiteral(spec.source.replace(/\.ctjs$/, ".js")),
      ),
    );

    const prefix = [];
    if (this.helpers.has("noMatch")) {
      prefix.push(
        t.variableDeclaration("const", [
          t.variableDeclarator(
            t.identifier(NO_MATCH),
            t.callExpression(t.identifier("Symbol"), [t.stringLiteral("ctjs.noMatch")]),
          ),
        ]),
      );
    }

    const groupDecls = [];
    for (const group of runtimeGroups) {
      groupDecls.push(...this.compileRuntimeGroup(group));
    }

    const finalBody = [...importDecls, ...prefix, ...groupDecls, ...out];

    // A <fn> group can share a name with a regular runtime binding only if the
    // regular binding wins.  This keeps the transform predictable.
    for (const group of this.groups.values()) {
      const binding = this.global.lookup(group.name);
      if (binding && binding.type === "runtime") {
        throw new CTError(
          ErrorCodes.STAGE_LEAK,
          `Compile-time function group '${group.name}' conflicts with a runtime binding`,
          group.clauses[0]?.loc,
        );
      }
    }

    const newProgram = t.program(finalBody, program.directives ?? [], program.sourceType ?? "module");
    newProgram.interpreter = program.interpreter ?? null;
    newProgram.sourceFile = program.sourceFile ?? this.filename;
    return {
      ast: t.file(newProgram),
      exports: this.exports,
      groups: this.groups,
    };
  }

  importCompileTime(marker, env) {
    const source = marker.args[0];
    const specs = marker.args[1];
    if (!t.isStringLiteral(source) || !t.isArrayExpression(specs)) {
      throw new CTError(ErrorCodes.SYNTAX, "Malformed <import> marker", marker.loc);
    }
    const requested = specs.elements.map((element) => {
      if (!t.isObjectExpression(element)) {
        throw new CTError(ErrorCodes.SYNTAX, "Malformed <import> specifier", marker.loc);
      }
      const imported = element.properties.find(
        (p) =>
          t.isObjectProperty(p) &&
          ((t.isIdentifier(p.key) && p.key.name === "imported") ||
            (t.isStringLiteral(p.key) && p.key.value === "imported")),
      );
      const local = element.properties.find(
        (p) =>
          t.isObjectProperty(p) &&
          ((t.isIdentifier(p.key) && p.key.name === "local") ||
            (t.isStringLiteral(p.key) && p.key.value === "local")),
      );
      return {
        imported: imported?.value?.value,
        local: local?.value?.value,
      };
    });
    const resolver = this.options.resolveCompileTimeImport;
    if (typeof resolver !== "function") {
      throw new CTError(
        ErrorCodes.MODULE_NOT_FOUND,
        `Cannot resolve <import> from '${source.value}' without a module resolver`,
        marker.loc,
        "Pass options.resolveCompileTimeImport(source, specifiers, loc) to the Babel plugin, or use the ctjs CLI.",
      );
    }
    const resolved = resolver(source.value, requested, marker.loc);
    if (!resolved || typeof resolved !== "object") {
      throw new CTError(
        ErrorCodes.MODULE_NOT_FOUND,
        `Compile-time module '${source.value}' did not provide exports`,
        marker.loc,
      );
    }
    for (const spec of requested) {
      if (!(spec.imported in resolved)) {
        throw new CTError(
          ErrorCodes.MODULE_NOT_FOUND,
          `Compile-time module '${source.value}' does not export '${spec.imported}'`,
          marker.loc,
        );
      }
      env.declare(spec.local, { type: "ct", value: resolved[spec.imported] });
      this.ctImports.set(spec.local, {
        source: source.value,
        imported: spec.imported,
      });
      this.imported.add(spec.local);
    }
  }

  addClause(node, meta) {
    const { guard, bodyStart } = guardOfClause(node);
    const params = node.params.map((param) => t.cloneNode(param));
    const body = node.body.body.slice(bodyStart).map((stmt) => t.cloneNode(stmt));
    for (const kind of ["await", "import", "export-const"]) {
      const forbidden = findMarker({ body }, kind);
      if (forbidden) {
        throw new CTError(
          ErrorCodes.STAGE_LEAK,
          kind === "await"
            ? "<await> is not allowed inside <fn>"
            : `<${kind === "export-const" ? "export" : kind}> is not allowed inside <fn>`,
          forbidden.loc,
        );
      }
    }
    const clause = {
      id: meta.id,
      group: meta.group,
      exported: meta.exported,
      loc: meta.loc,
      node,
      params,
      guard,
      body,
      fnName: node.id.name,
    };
    let group = this.groups.get(meta.group);
    if (!group) {
      group = new CTFunctionGroup(meta.group, [], this);
      this.groups.set(meta.group, group);
    }
    group.clauses.push(clause);
    if (meta.exported) group.exported = true;
  }

  error(code, message, loc, hint) {
    throw new CTError(code, message, loc, hint);
  }

  isCompileTimeObject(node, env) {
    if (t.isIdentifier(node)) {
      return env.lookup(node.name)?.type === "ct";
    }
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
      return this.isCompileTimeObject(node.object, env);
    }
    if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
      return this.isCompileTimeCallee(node.callee, env);
    }
    if (t.isNewExpression(node)) {
      return this.isCompileTimeCallee(node.callee, env);
    }
    return false;
  }

  isCompileTimeCallee(callee, env) {
    if (t.isIdentifier(callee)) {
      const binding = env.lookup(callee.name);
      if (binding?.type !== "ct") return false;
      return true;
    }
    if (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) {
      return this.isCompileTimeObject(callee.object, env);
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // Compile-time evaluation
  // ---------------------------------------------------------------------

  eval(node, env) {
    if (this.fnDepth > 0) {
      const awaitMarker = findMarker(node, "await");
      if (awaitMarker) {
        throw new CTError(
          ErrorCodes.STAGE_LEAK,
          "<await> is not allowed inside <fn>",
          awaitMarker.loc,
        );
      }
    }
    if (this.runtimeDepth > 0) {
      const awaitMarker = findMarker(node, "await");
      if (awaitMarker) {
        throw new CTError(
          ErrorCodes.STAGE_LEAK,
          "<await> cannot appear inside a runtime branch or function",
          awaitMarker.loc,
        );
      }
    }
    try {
      return { ok: true, value: this.evalNode(node, env) };
    } catch (error) {
      if (error instanceof NotCompileTime) {
        return { ok: false, reason: error.message };
      }
      throw error;
    }
  }

  evalNode(node, env) {
    if (!node) throw new NotCompileTime("empty expression");

    const marker = markerOf(node);
    if (marker?.kind === "await") {
      const result = this.evalNode(marker.args[0], env);
      if (isThenable(result)) {
        throw new CTError(
          ErrorCodes.AWAIT_ASYNC,
          "<await> received a Promise; compile-time APIs must be synchronous in this build",
          marker.loc,
          "The ctjs CLI can order synchronous collectors; async compile-time work is not supported by the Babel transform.",
        );
      }
      return result;
    }
    if (marker) {
      throw new NotCompileTime(`<${marker.kind}> is not a compile-time expression`);
    }

    if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) {
      return node.value;
    }
    if (t.isNullLiteral(node)) return null;
    if (t.isBigIntLiteral(node)) return BigInt(node.value);
    if (t.isRegExpLiteral(node)) return new RegExp(node.pattern, node.flags);
    if (t.isThisExpression(node)) return t.thisExpression();
    if (t.isSuper(node)) return t.super();
    if (t.isMetaProperty(node)) return t.cloneNode(node);
    if (t.isIdentifier(node)) {
      const binding = env.lookup(node.name);
      if (binding) {
        if (binding.type === "ct") return binding.value;
        throw new NotCompileTime(`'${node.name}' is a runtime value`);
      }
      if (node.name === "undefined") return undefined;
      if (node.name === "NaN") return NaN;
      if (node.name === "Infinity") return Infinity;
      if (node.name === "Math") return SAFE_MATH;
      if (node.name === "JSON") return JSON;
      if (node.name === "String") return String;
      if (node.name === "Number") return Number;
      if (node.name === "Boolean") return Boolean;
      if (node.name === "Array") return Array;
      if (node.name === "Object") return Object;
      if (node.name === "Symbol") return Symbol;
      if (node.name === "RegExp") return RegExp;
      const group = this.groups.get(node.name);
      if (group) {
        throw new CTError(
          ErrorCodes.STAGE_LEAK,
          `Compile-time function group '${node.name}' cannot be used as a value`,
          node.loc?.start ?? null,
          "Call it directly so the compiler can select a clause.",
        );
      }
      throw new NotCompileTime(`'${node.name}' is not bound at compile time`);
    }
    if (t.isThisExpression(node) || t.isSuper(node)) {
      throw new NotCompileTime("'this' is not available at compile time");
    }
    if (t.isTemplateLiteral(node)) {
      let out = "";
      for (let i = 0; i < node.quasis.length; i++) {
        out += node.quasis[i].value.cooked ?? node.quasis[i].value.raw;
        if (i < node.expressions.length) out += String(this.evalNode(node.expressions[i], env));
      }
      return out;
    }
    if (t.isTaggedTemplateExpression(node)) {
      throw new NotCompileTime("tagged templates are not supported at compile time");
    }
    if (t.isArrayExpression(node)) {
      const out = [];
      for (const element of node.elements) {
        if (!element) {
          out.push(undefined);
        } else if (t.isSpreadElement(element)) {
          const value = this.evalNode(element.argument, env);
          if (!isIterable(value)) throw new NotCompileTime("spread value is not iterable");
          out.push(...value);
        } else {
          out.push(this.evalNode(element, env));
        }
      }
      return out;
    }
    if (t.isObjectExpression(node)) {
      const out = {};
      for (const prop of node.properties) {
        if (t.isSpreadElement(prop)) {
          const value = this.evalNode(prop.argument, env);
          if (!isPlainObject(value)) throw new NotCompileTime("spread value is not a plain object");
          Object.assign(out, value);
          continue;
        }
        if (!t.isObjectProperty(prop)) {
          throw new NotCompileTime("object methods are not supported at compile time");
        }
        let key;
        if (prop.computed) key = this.evalNode(prop.key, env);
        else if (t.isIdentifier(prop.key)) key = prop.key.name;
        else key = prop.key.value;
        out[key] = this.evalNode(prop.value, env);
      }
      return out;
    }
    if (t.isUnaryExpression(node)) {
      const value = this.evalNode(node.argument, env);
      switch (node.operator) {
        case "-":
          return -value;
        case "+":
          return +value;
        case "!":
          return !value;
        case "~":
          return ~value;
        case "typeof":
          return typeof value;
        case "void":
          return undefined;
        default:
          throw new NotCompileTime(`unsupported unary operator ${node.operator}`);
      }
    }
    if (t.isBinaryExpression(node)) {
      const left = this.evalNode(node.left, env);
      const right = this.evalNode(node.right, env);
      switch (node.operator) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          return left / right;
        case "%":
          return left % right;
        case "**":
          return left ** right;
        case "==":
          return left == right; // eslint-disable-line eqeqeq
        case "!=":
          return left != right; // eslint-disable-line eqeqeq
        case "===":
          return left === right;
        case "!==":
          return left !== right;
        case "<":
          return left < right;
        case "<=":
          return left <= right;
        case ">":
          return left > right;
        case ">=":
          return left >= right;
        case "&":
          return left & right;
        case "|":
          return left | right;
        case "^":
          return left ^ right;
        case "<<":
          return left << right;
        case ">>":
          return left >> right;
        case ">>>":
          return left >>> right;
        case "in":
          return left in right;
        case "instanceof":
          return left instanceof right;
        default:
          throw new NotCompileTime(`unsupported binary operator ${node.operator}`);
      }
    }
    if (t.isLogicalExpression(node)) {
      const left = this.evalNode(node.left, env);
      if (node.operator === "&&") return left ? this.evalNode(node.right, env) : left;
      if (node.operator === "||") return left ? left : this.evalNode(node.right, env);
      if (node.operator === "??") return left ?? this.evalNode(node.right, env);
      throw new NotCompileTime(`unsupported logical operator ${node.operator}`);
    }
    if (t.isConditionalExpression(node)) {
      return this.evalNode(node.test, env)
        ? this.evalNode(node.consequent, env)
        : this.evalNode(node.alternate, env);
    }
    if (t.isSequenceExpression(node)) {
      let value;
      for (const expr of node.expressions) value = this.evalNode(expr, env);
      return value;
    }
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
      const object = this.evalNode(node.object, env);
      if ((object === null || object === undefined) && node.optional) return undefined;
      let key;
      if (node.computed) key = this.evalNode(node.property, env);
      else if (t.isIdentifier(node.property)) key = node.property.name;
      else key = node.property.value;
      if (object === null || object === undefined) {
        throw new CTError(
          ErrorCodes.RUNTIME_IN_COMPILE_TIME,
          `Cannot read '${String(key)}' of ${object}`,
          node.loc?.start ?? null,
        );
      }
      return object[key];
    }
    if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
      let thisArg;
      let fn;
      let calleeLoc = node.loc?.start ?? null;
      if (t.isMemberExpression(node.callee) || t.isOptionalMemberExpression(node.callee)) {
        const member = node.callee;
        thisArg = this.evalNode(member.object, env);
        if ((thisArg === null || thisArg === undefined) && member.optional) return undefined;
        let key;
        if (member.computed) key = this.evalNode(member.property, env);
        else if (t.isIdentifier(member.property)) key = member.property.name;
        else key = member.property.value;
        fn = thisArg?.[key];
        calleeLoc = member.loc?.start ?? calleeLoc;
      } else if (t.isIdentifier(node.callee)) {
        const binding = env.lookup(node.callee.name);
        if (binding?.type === "ct") {
          if (binding.value instanceof CTFunctionGroup) {
            const args = [];
            for (const arg of node.arguments) {
              if (t.isSpreadElement(arg)) {
                const value = this.evalNode(arg.argument, env);
                if (!isIterable(value)) throw new NotCompileTime("spread argument is not iterable");
                args.push(...value);
              } else {
                args.push(this.evalNode(arg, env));
              }
            }
            return this.callGroup(binding.value, args, node.loc?.start ?? null);
          }
          fn = binding.value;
        } else if (binding?.type === "runtime") {
          throw new NotCompileTime(`'${node.callee.name}' is a runtime function`);
        } else {
          const group = this.groups.get(node.callee.name);
          if (group) {
            const args = [];
            for (const arg of node.arguments) {
              if (t.isSpreadElement(arg)) {
                const value = this.evalNode(arg.argument, env);
                if (!isIterable(value)) throw new NotCompileTime("spread argument is not iterable");
                args.push(...value);
              } else {
                args.push(this.evalNode(arg, env));
              }
            }
            return this.callGroup(group, args, node.loc?.start ?? null);
          }
          fn = this.builtin(node.callee.name);
          if (fn === undefined) {
            throw new NotCompileTime(`'${node.callee.name}' is not a compile-time function`);
          }
        }
      } else {
        fn = this.evalNode(node.callee, env);
      }

      if (typeof fn !== "function" && !(fn && typeof fn.call === "function")) {
        throw new CTError(
          ErrorCodes.RUNTIME_IN_COMPILE_TIME,
          `Value is not callable at compile time: ${describeValue(fn)}`,
          calleeLoc,
        );
      }
      const args = [];
      for (const arg of node.arguments) {
        if (t.isSpreadElement(arg)) {
          const value = this.evalNode(arg.argument, env);
          if (!isIterable(value)) throw new NotCompileTime("spread argument is not iterable");
          args.push(...value);
        } else {
          args.push(this.evalNode(arg, env));
        }
      }
      try {
        const value = Reflect.apply(fn, thisArg, args);
        if (isThenable(value)) {
          throw new CTError(
            ErrorCodes.AWAIT_ASYNC,
            "A compile-time API returned a Promise; compile-time APIs must be synchronous",
            node.loc?.start ?? null,
            "Use <await> with a synchronous barrier, or move the async work outside the macro.",
          );
        }
        return value;
      } catch (error) {
        if (error instanceof CTError) throw error;
        throw new CTError(
          ErrorCodes.RUNTIME_IN_COMPILE_TIME,
          `Compile-time call failed: ${error?.message ?? String(error)}`,
          node.loc?.start ?? null,
        );
      }
    }
    if (t.isNewExpression(node)) {
      const ctor = this.evalNode(node.callee, env);
      const args = [];
      for (const arg of node.arguments) {
        if (t.isSpreadElement(arg)) {
          const value = this.evalNode(arg.argument, env);
          if (!isIterable(value)) throw new NotCompileTime("spread argument is not iterable");
          args.push(...value);
        } else {
          args.push(this.evalNode(arg, env));
        }
      }
      if (typeof ctor !== "function") {
        throw new CTError(
          ErrorCodes.RUNTIME_IN_COMPILE_TIME,
          `Value is not constructible at compile time: ${describeValue(ctor)}`,
          node.loc?.start ?? null,
        );
      }
      try {
        return new ctor(...args);
      } catch (error) {
        throw new CTError(
          ErrorCodes.RUNTIME_IN_COMPILE_TIME,
          `Compile-time construction failed: ${error?.message ?? String(error)}`,
          node.loc?.start ?? null,
        );
      }
    }
    if (t.isArrowFunctionExpression(node) || t.isFunctionExpression(node)) {
      const closure = new CTClosure(this, node, env);
      return (...args) => closure.call(args);
    }
    if (t.isObjectMethod(node) || t.isClassMethod(node) || t.isClassExpression(node)) {
      throw new NotCompileTime("classes and methods are not supported at compile time");
    }
    if (t.isAssignmentExpression(node)) {
      if (!t.isIdentifier(node.left)) {
        throw new NotCompileTime("only local identifier assignment is supported at compile time");
      }
      const binding = env.lookup(node.left.name);
      if (!binding) throw new NotCompileTime(`'${node.left.name}' is not bound at compile time`);
      if (binding.type !== "ct") throw new NotCompileTime(`'${node.left.name}' is a runtime value`);
      if (!binding.mutable) {
        throw new CTError(
          ErrorCodes.RUNTIME_IN_CONST,
          `Cannot assign to compile-time constant '${node.left.name}'`,
          node.loc?.start ?? null,
        );
      }
      const right = this.evalNode(node.right, env);
      let value = right;
      if (node.operator !== "=") {
        const op = node.operator.slice(0, -1);
        if (op === "&&") value = binding.value && right;
        else if (op === "||") value = binding.value || right;
        else if (op === "??") value = binding.value ?? right;
        else value = this.applyBinary(op, binding.value, right, node);
      }
      binding.value = value;
      return value;
    }
    if (t.isUpdateExpression(node)) {
      if (!t.isIdentifier(node.argument)) {
        throw new NotCompileTime("only local identifier updates are supported at compile time");
      }
      const binding = env.lookup(node.argument.name);
      if (!binding) throw new NotCompileTime(`'${node.argument.name}' is not bound at compile time`);
      if (binding.type !== "ct") throw new NotCompileTime(`'${node.argument.name}' is a runtime value`);
      if (!binding.mutable) {
        throw new CTError(
          ErrorCodes.RUNTIME_IN_CONST,
          `Cannot update compile-time constant '${node.argument.name}'`,
          node.loc?.start ?? null,
        );
      }
      const oldValue = binding.value;
      binding.value = node.operator === "++" ? oldValue + 1 : oldValue - 1;
      return node.prefix ? binding.value : oldValue;
    }
    if (t.isAwaitExpression(node)) {
      throw new NotCompileTime("runtime await is not allowed at compile time");
    }
    if (t.isYieldExpression(node)) {
      throw new NotCompileTime("yield is not allowed at compile time");
    }
    throw new NotCompileTime(`unsupported compile-time expression ${node.type}`);
  }

  applyBinary(operator, left, right, node) {
    switch (operator) {
      case "+":
        return left + right;
      case "-":
        return left - right;
      case "*":
        return left * right;
      case "/":
        return left / right;
      case "%":
        return left % right;
      case "**":
        return left ** right;
      case "&":
        return left & right;
      case "|":
        return left | right;
      case "^":
        return left ^ right;
      case "<<":
        return left << right;
      case ">>":
        return left >> right;
      case ">>>":
        return left >>> right;
      default:
        throw new NotCompileTime(`unsupported assignment operator ${operator}`);
    }
  }

  builtin(name) {
    switch (name) {
      case "String":
        return String;
      case "Number":
        return Number;
      case "Boolean":
        return Boolean;
      case "Array":
        return Array;
      case "Object":
        return Object;
      case "Symbol":
        return Symbol;
      case "Math":
        return SAFE_MATH;
      case "JSON":
        return JSON;
      case "RegExp":
        return RegExp;
      case "parseInt":
        return parseInt;
      case "parseFloat":
        return parseFloat;
      case "isNaN":
        return isNaN;
      case "isFinite":
        return isFinite;
      default:
        return undefined;
    }
  }

  callClosure(closure, args, loc) {
    const node = closure.node;
    const env = closure.env.child();
    const params = node.params;
    let argIndex = 0;
    for (let i = 0; i < params.length; i++) {
      const param = params[i];
      if (t.isRestElement(param)) {
        env.declare(param.argument.name, {
          type: "ct",
          value: args.slice(argIndex),
          mutable: true,
        });
        argIndex = args.length;
      } else if (t.isIdentifier(param)) {
        env.declare(param.name, { type: "ct", value: args[argIndex], mutable: true });
        argIndex++;
      } else {
        throw new CTError(
          ErrorCodes.UNSUPPORTED,
          "Only identifier parameters are supported in compile-time closures",
          loc,
        );
      }
    }
    this.fnDepth++;
    try {
      if (t.isBlockStatement(node.body)) {
        const completion = this.executeStatements(node.body.body, env);
        return completion.type === "return" ? completion.value : undefined;
      }
      return this.evalNode(node.body, env);
    } finally {
      this.fnDepth--;
    }
  }

  callGroup(group, args, loc) {
    if (group.owner && group.owner !== this) {
      return group.owner.callGroup(group, args, loc);
    }
    this.callDepth++;
    if (this.callDepth > this.maxCallDepth) {
      this.callDepth--;
      throw new CTError(
        ErrorCodes.UNSUPPORTED,
        `Compile-time recursion limit exceeded while calling '${group.name}'`,
        loc,
      );
    }
    this.fnDepth++;
    try {
      for (const clause of group.clauses) {
        const bind = this.bindClause(clause, args, loc);
        if (!bind) continue;
        let matches = true;
        if (clause.guard) {
          const guard = this.eval(clause.guard, bind);
          if (!guard.ok) {
            throw new CTError(
              ErrorCodes.RUNTIME_IN_COMPILE_TIME,
              `Clause guard for '${group.name}' is not compile-time: ${guard.reason}`,
              clause.loc,
            );
          }
          matches = Boolean(guard.value);
        }
        if (!matches) continue;
        const completion = this.executeStatements(clause.body, bind);
        return completion.type === "return" ? completion.value : undefined;
      }
      throw new CTError(
        ErrorCodes.NO_CLAUSE,
        `No matching <fn> clause for '${group.name}'`,
        loc,
      );
    } catch (error) {
      if (error instanceof NotCompileTime) {
        throw new CTError(
          ErrorCodes.RUNTIME_IN_COMPILE_TIME,
          `Compile-time function '${group.name}' could not be evaluated: ${error.message}`,
          loc,
        );
      }
      throw error;
    } finally {
      this.callDepth--;
      this.fnDepth--;
    }
  }

  bindClause(clause, args, loc) {
    const env = this.global.child();
    let index = 0;
    for (const param of clause.params) {
      if (t.isRestElement(param)) {
        if (!t.isIdentifier(param.argument)) {
          throw new CTError(ErrorCodes.UNSUPPORTED, "Unsupported rest parameter", loc);
        }
        env.declare(param.argument.name, {
          type: "ct",
          value: args.slice(index),
          mutable: true,
        });
        index = args.length;
      } else if (t.isIdentifier(param)) {
        if (index >= args.length) return null;
        env.declare(param.name, { type: "ct", value: args[index], mutable: true });
        index++;
      } else {
        throw new CTError(
          ErrorCodes.UNSUPPORTED,
          "Only identifier parameters are supported in <fn>",
          loc,
        );
      }
    }
    return env;
  }

  executeStatements(statements, env) {
    const local = env.child();
    for (const stmt of statements) {
      const completion = this.executeStatement(stmt, local);
      if (completion.type !== "normal") return completion;
    }
    return { type: "normal" };
  }

  executeStatement(stmt, env) {
    if (t.isEmptyStatement(stmt)) return { type: "normal" };
    if (t.isExpressionStatement(stmt)) {
      this.evalNode(stmt.expression, env);
      return { type: "normal" };
    }
    if (t.isVariableDeclaration(stmt)) {
      for (const decl of stmt.declarations) {
        const initMarker = decl.init ? markerOf(decl.init) : null;
        const initNode =
          initMarker?.kind === "const" || initMarker?.kind === "export-const"
            ? initMarker.args[0]
            : decl.init;
        const init = initNode ? this.evalNode(initNode, env) : undefined;
        if (t.isIdentifier(decl.id)) {
          env.declare(decl.id.name, {
            type: "ct",
            value: init,
            mutable: stmt.kind !== "const",
          });
        } else {
          throw new CTError(
            ErrorCodes.UNSUPPORTED,
            "Destructuring is not supported in compile-time declarations",
            stmt.loc?.start ?? null,
          );
        }
      }
      return { type: "normal" };
    }
    if (t.isReturnStatement(stmt)) {
      return {
        type: "return",
        value: stmt.argument ? this.evalNode(stmt.argument, env) : undefined,
      };
    }
    if (t.isIfStatement(stmt)) {
      const marker = markerOf(stmt.test);
      const testNode = marker?.kind === "if" ? marker.args[0] : stmt.test;
      const value = this.evalNode(testNode, env);
      const branch = value ? stmt.consequent : stmt.alternate;
      if (!branch) return { type: "normal" };
      return this.executeStatement(branch, env);
    }
    if (t.isBlockStatement(stmt)) {
      return this.executeStatements(stmt.body, env);
    }
    if (t.isForOfStatement(stmt)) {
      const marker = markerOf(stmt.right);
      const iterableNode = marker?.kind === "for" ? marker.args[0] : stmt.right;
      const iterable = this.evalNode(iterableNode, env);
      if (!isIterable(iterable)) {
        throw new CTError(
          ErrorCodes.RUNTIME_IN_COMPILE_TIME,
          "Compile-time <for> expects an iterable value",
          stmt.loc?.start ?? null,
        );
      }
      let index = 0;
      for (const item of iterable) {
        const child = env.child();
        if (!t.isVariableDeclaration(stmt.left) || stmt.left.declarations.length !== 1) {
          throw new CTError(ErrorCodes.UNSUPPORTED, "Unsupported <for> loop variable", stmt.loc?.start ?? null);
        }
        const id = stmt.left.declarations[0].id;
        if (!t.isIdentifier(id)) {
          throw new CTError(ErrorCodes.UNSUPPORTED, "Unsupported <for> loop variable", stmt.loc?.start ?? null);
        }
        child.declare(id.name, { type: "ct", value: item });
        const completion = this.executeStatement(stmt.body, child);
        if (completion.type === "return") return completion;
        if (completion.type === "break") break;
        if (completion.type === "continue") continue;
        index++;
      }
      return { type: "normal" };
    }
    if (t.isSwitchStatement(stmt)) {
      const marker = markerOf(stmt.discriminant);
      const discNode = marker?.kind === "switch" ? marker.args[0] : stmt.discriminant;
      const discriminant = this.evalNode(discNode, env);
      let start = -1;
      let defaultIndex = -1;
      for (let i = 0; i < stmt.cases.length; i++) {
        const c = stmt.cases[i];
        if (!c.test) {
          defaultIndex = i;
          continue;
        }
        if (t.isIdentifier(c.test, { name: "_" })) {
          if (start < 0) start = i;
          continue;
        }
        const value = this.evalNode(c.test, env);
        if (start < 0 && value === discriminant) start = i;
      }
      if (start < 0) start = defaultIndex;
      if (start < 0) return { type: "normal" };
      for (let i = start; i < stmt.cases.length; i++) {
        for (const s of stmt.cases[i].consequent) {
          const completion = this.executeStatement(s, env);
          if (completion.type === "break") return { type: "normal" };
          if (completion.type !== "normal") return completion;
        }
      }
      return { type: "normal" };
    }
    if (t.isBreakStatement(stmt)) return { type: "break" };
    if (t.isContinueStatement(stmt)) return { type: "continue" };
    if (t.isThrowStatement(stmt)) {
      const value = this.evalNode(stmt.argument, env);
      throw new CTError(
        ErrorCodes.RUNTIME_IN_COMPILE_TIME,
        `Compile-time throw: ${String(value)}`,
        stmt.loc?.start ?? null,
      );
    }
    if (t.isFunctionDeclaration(stmt)) {
      throw new CTError(
        ErrorCodes.UNSUPPORTED,
        "Nested <fn>/function declarations are not supported inside compile-time functions",
        stmt.loc?.start ?? null,
      );
    }
    if (t.isLabeledStatement(stmt)) return this.executeStatement(stmt.body, env);
    throw new CTError(
      ErrorCodes.UNSUPPORTED,
      `Unsupported statement in compile-time function: ${stmt.type}`,
      stmt.loc?.start ?? null,
    );
  }

  // ---------------------------------------------------------------------
  // Code generation
  // ---------------------------------------------------------------------

  compileStatement(stmt, env, out, ctx) {
    const previous = this.runtimeDepth;
    if (ctx.runtime) this.runtimeDepth++;
    try {
      this.compileStatementInner(stmt, env, out, ctx);
    } finally {
      this.runtimeDepth = previous;
    }
  }

  compileStatementInner(stmt, env, out, ctx) {
    if (t.isEmptyStatement(stmt)) return;
    if (t.isExpressionStatement(stmt)) {
      const marker = markerOf(stmt.expression);
      if (marker?.kind === "import") {
        if (ctx.runtime) {
          throw new CTError(
            ErrorCodes.STAGE_LEAK,
            "<import> cannot appear inside a runtime branch",
            marker.loc,
          );
        }
        this.importCompileTime(marker, env);
        return;
      }
      if (
        (t.isCallExpression(stmt.expression) || t.isOptionalCallExpression(stmt.expression)) &&
        this.isCompileTimeCallee(stmt.expression.callee, env)
      ) {
        if (ctx.runtime) {
          const awaitMarker = findMarker(stmt.expression, "await");
          if (awaitMarker) {
            throw new CTError(
              ErrorCodes.STAGE_LEAK,
              "<await> cannot appear inside a runtime branch or function",
              awaitMarker.loc,
            );
          }
          const result = this.eval(stmt.expression, env);
          if (result.ok) {
            throw new CTError(
              ErrorCodes.STAGE_LEAK,
              "A compile-time API call cannot appear inside a runtime branch",
              stmt.expression.loc?.start ?? null,
              "Move the call to a compile-time context, or use a runtime function instead.",
            );
          }
          throw new CTError(
            ErrorCodes.RUNTIME_ARG_IN_COMPILE_TIME,
            `Compile-time API call is not fully compile-time: ${result.reason}`,
            stmt.expression.loc?.start ?? null,
            "Arguments to compile-time APIs must be compile-time values.",
          );
        }
        const result = this.eval(stmt.expression, env);
        if (!result.ok) {
          throw new CTError(
            ErrorCodes.RUNTIME_ARG_IN_COMPILE_TIME,
            `Compile-time API call is not fully compile-time: ${result.reason}`,
            stmt.expression.loc?.start ?? null,
            "Arguments to compile-time APIs must be compile-time values.",
          );
        }
        return;
      }
      const expr = this.compileExpression(stmt.expression, env, ctx);
      out.push(t.expressionStatement(expr));
      return;
    }

    if (t.isVariableDeclaration(stmt)) {
      this.compileVariableDeclaration(stmt, env, out, ctx);
      return;
    }

    if (t.isFunctionDeclaration(stmt)) {
      const clause = clauseMarkerOf(stmt);
      if (clause) {
        if (!ctx.topLevel) {
          throw new CTError(
            ErrorCodes.UNSUPPORTED,
            "<fn> clauses are only supported at module top level",
            clause.loc,
          );
        }
        return; // collected and emitted at the end
      }
      out.push(this.compileFunction(stmt, env, ctx));
      return;
    }

    if (t.isIfStatement(stmt)) {
      const marker = markerOf(stmt.test);
      if (marker?.kind === "if") {
        this.compileIfMarker(stmt, marker, env, out, ctx);
        return;
      }
      const test = this.compileExpression(stmt.test, env, ctx);
      const consequent = this.compileSubStatement(stmt.consequent, env, { ...ctx, runtime: ctx.runtime });
      const alternate = stmt.alternate
        ? this.compileSubStatement(stmt.alternate, env, { ...ctx, runtime: ctx.runtime })
        : null;
      out.push(t.ifStatement(test, consequent, alternate));
      return;
    }

    if (t.isForOfStatement(stmt)) {
      const marker = markerOf(stmt.right);
      if (marker?.kind === "for") {
        this.compileForMarker(stmt, marker, env, out, ctx);
        return;
      }
      this.compileNormalForOf(stmt, env, out, ctx);
      return;
    }

    if (t.isSwitchStatement(stmt)) {
      const marker = markerOf(stmt.discriminant);
      if (marker?.kind === "switch") {
        this.compileSwitchMarker(stmt, marker, env, out, ctx);
        return;
      }
      this.compileNormalSwitch(stmt, env, out, ctx);
      return;
    }

    if (t.isReturnStatement(stmt)) {
      out.push(
        t.returnStatement(stmt.argument ? this.compileExpression(stmt.argument, env, ctx) : null),
      );
      return;
    }
    if (t.isThrowStatement(stmt)) {
      out.push(t.throwStatement(this.compileExpression(stmt.argument, env, ctx)));
      return;
    }
    if (t.isBreakStatement(stmt) || t.isContinueStatement(stmt)) {
      out.push(t.cloneNode(stmt));
      return;
    }
    if (t.isBlockStatement(stmt)) {
      out.push(this.compileBlock(stmt.body, env, ctx));
      return;
    }
    if (t.isWhileStatement(stmt)) {
      const test = this.compileExpression(stmt.test, env, ctx);
      const body = this.compileSubStatement(stmt.body, env, { ...ctx, runtime: ctx.runtime });
      out.push(t.whileStatement(test, body));
      return;
    }
    if (t.isDoWhileStatement(stmt)) {
      const body = this.compileSubStatement(stmt.body, env, { ...ctx, runtime: ctx.runtime });
      const test = this.compileExpression(stmt.test, env, ctx);
      out.push(t.doWhileStatement(body, test));
      return;
    }
    if (t.isForStatement(stmt)) {
      const init = stmt.init
        ? t.isVariableDeclaration(stmt.init)
          ? this.compileVarDeclInline(stmt.init, env, ctx)
          : this.compileExpression(stmt.init, env, ctx)
        : null;
      const test = stmt.test ? this.compileExpression(stmt.test, env, ctx) : null;
      const update = stmt.update ? this.compileExpression(stmt.update, env, ctx) : null;
      const body = this.compileSubStatement(stmt.body, env, { ...ctx, runtime: ctx.runtime });
      out.push(t.forStatement(init, test, update, body));
      return;
    }
    if (t.isTryStatement(stmt)) {
      const block = this.compileBlock(stmt.block.body, env, ctx);
      let handler = null;
      if (stmt.handler) {
        const handlerEnv = env.child();
        for (const name of boundNames(stmt.handler.param)) {
          handlerEnv.declare(name, { type: "runtime", kind: "param" });
        }
        handler = t.catchClause(
          stmt.handler.param ? t.cloneNode(stmt.handler.param) : null,
          this.compileBlock(stmt.handler.body.body, handlerEnv, ctx),
        );
      }
      const finalizer = stmt.finalizer ? this.compileBlock(stmt.finalizer.body, env, ctx) : null;
      out.push(t.tryStatement(block, handler, finalizer));
      return;
    }
    if (t.isLabeledStatement(stmt)) {
      out.push(
        t.labeledStatement(stmt.label, this.compileSubStatement(stmt.body, env, ctx)),
      );
      return;
    }
    if (t.isExportNamedDeclaration(stmt)) {
      if (!stmt.declaration) {
        const specifiers = stmt.specifiers.filter(
          (spec) => env.lookup(spec.local.name)?.type !== "ct",
        );
        if (specifiers.length > 0) {
          out.push(t.exportNamedDeclaration(null, specifiers.map((s) => t.cloneNode(s)), stmt.source));
        }
        return;
      }
      const inner = [];
      this.compileStatement(stmt.declaration, env, inner, { ...ctx, topLevel: false });
      for (const item of inner) {
        if (t.isVariableDeclaration(item) || t.isFunctionDeclaration(item) || t.isClassDeclaration(item)) {
          out.push(t.exportNamedDeclaration(item, []));
        } else {
          out.push(item);
        }
      }
      return;
    }
    if (t.isExportDefaultDeclaration(stmt)) {
      const decl = stmt.declaration;
      if (t.isExpression(decl)) {
        out.push(t.exportDefaultDeclaration(this.compileExpression(decl, env, ctx)));
      } else {
        const inner = [];
        this.compileStatement(decl, env, inner, { ...ctx, topLevel: false });
        if (inner.length === 1 && (t.isFunctionDeclaration(inner[0]) || t.isClassDeclaration(inner[0]))) {
          out.push(t.exportDefaultDeclaration(inner[0]));
        } else {
          out.push(...inner);
        }
      }
      return;
    }
    if (t.isImportDeclaration(stmt)) {
      out.push(t.cloneNode(stmt));
      return;
    }
    if (t.isClassDeclaration(stmt)) {
      out.push(this.compileClass(stmt, env, ctx));
      return;
    }
    if (t.isDebuggerStatement(stmt)) {
      out.push(t.cloneNode(stmt));
      return;
    }
    throw new CTError(
      ErrorCodes.UNSUPPORTED,
      `Unsupported statement: ${stmt.type}`,
      stmt.loc?.start ?? null,
    );
  }

  compileSubStatement(stmt, env, ctx) {
    if (t.isBlockStatement(stmt)) {
      return this.compileBlock(stmt.body, env, ctx);
    }
    const out = [];
    this.compileStatement(stmt, env, out, { ...ctx, topLevel: false });
    if (out.length === 1) return out[0];
    return t.blockStatement(out);
  }

  compileBlock(statements, env, ctx) {
    const child = env.child();
    const out = [];
    const blockCtx = { ...ctx, topLevel: false };
    for (const stmt of statements) {
      this.compileStatement(stmt, child, out, blockCtx);
    }
    return t.blockStatement(out);
  }

  compileVarDeclInline(stmt, env, ctx) {
    const decls = [];
    for (const decl of stmt.declarations) {
      const init = decl.init ? this.compileExpression(decl.init, env, ctx) : null;
      decls.push(t.variableDeclarator(t.cloneNode(decl.id), init));
      for (const name of boundNames(decl.id)) {
        env.declare(name, { type: "runtime", kind: stmt.kind });
      }
    }
    return t.variableDeclaration(stmt.kind, decls);
  }

  compileVariableDeclaration(stmt, env, out, ctx) {
    const remaining = [];
    for (const decl of stmt.declarations) {
      const marker = decl.init ? markerOf(decl.init) : null;
      if (marker?.kind === "const" || marker?.kind === "export-const") {
        if (!t.isIdentifier(decl.id)) {
          throw new CTError(
            ErrorCodes.UNSUPPORTED,
            "<const> currently supports simple identifiers only",
            marker.loc,
          );
        }
        if (ctx.runtime) {
          const awaitMarker = findMarker(marker.args[0], "await");
          if (awaitMarker) {
            throw new CTError(
              ErrorCodes.STAGE_LEAK,
              "<await> cannot appear inside a runtime branch or function",
              awaitMarker.loc,
            );
          }
        }
        const result = this.eval(marker.args[0], env);
        if (!result.ok) {
          throw new CTError(
            ErrorCodes.RUNTIME_IN_CONST,
            `<const> '${decl.id.name}' depends on a runtime value: ${result.reason}`,
            marker.loc,
            "Compile-time bindings must be computable without runtime input. Use a normal const for runtime values.",
          );
        }
        const value = result.value;
        env.declare(decl.id.name, { type: "ct", value });
        if (marker.kind === "export-const") {
          this.exports.set(decl.id.name, value);
        }
        continue;
      }
      const init = decl.init ? this.compileExpression(decl.init, env, ctx) : null;
      for (const name of boundNames(decl.id)) {
        env.declare(name, { type: "runtime", kind: stmt.kind });
      }
      remaining.push(t.variableDeclarator(t.cloneNode(decl.id), init));
    }
    if (remaining.length > 0) {
      out.push(t.variableDeclaration(stmt.kind, remaining));
    }
  }

  compileIfMarker(stmt, marker, env, out, ctx) {
    const result = this.eval(marker.args[0], env);
    if (result.ok) {
      const branch = result.value ? stmt.consequent : stmt.alternate;
      if (!branch) return;
      out.push(this.compileSubStatement(branch, env, ctx));
      return;
    }
    const test = this.compileExpression(marker.args[0], env, { ...ctx, runtime: true });
    const consequent = this.compileSubStatement(stmt.consequent, env, {
      ...ctx,
      runtime: true,
    });
    const alternate = stmt.alternate
      ? this.compileSubStatement(stmt.alternate, env, { ...ctx, runtime: true })
      : null;
    out.push(t.ifStatement(test, consequent, alternate));
  }

  compileForMarker(stmt, marker, env, out, ctx) {
    const result = this.eval(marker.args[0], env);
    if (!result.ok) {
      this.compileNormalForOfWithRight(stmt, marker.args[0], env, out, ctx);
      return;
    }
    const iterable = result.value;
    if (!isIterable(iterable)) {
      throw new CTError(
        ErrorCodes.RUNTIME_IN_CONST,
        "<for> expects a compile-time iterable",
        marker.loc,
      );
    }
    if (!t.isVariableDeclaration(stmt.left) || stmt.left.declarations.length !== 1) {
      throw new CTError(ErrorCodes.UNSUPPORTED, "Unsupported <for> loop variable", marker.loc);
    }
    const id = stmt.left.declarations[0].id;
    if (!t.isIdentifier(id)) {
      throw new CTError(ErrorCodes.UNSUPPORTED, "Unsupported <for> loop variable", marker.loc);
    }
    const bodyStmt = stmt.body;
    if (containsLoopControl(bodyStmt)) {
      throw new CTError(
        ErrorCodes.UNSUPPORTED,
        "break/continue are not supported in an unrolled compile-time <for>",
        marker.loc,
        "Use a runtime <for> if the loop needs break/continue.",
      );
    }
    for (const item of iterable) {
      const child = env.child();
      child.declare(id.name, { type: "ct", value: item });
      if (t.isBlockStatement(bodyStmt)) {
        const compiled = [];
        for (const s of bodyStmt.body) {
          this.compileStatement(s, child, compiled, ctx);
        }
        out.push(t.blockStatement(compiled));
      } else {
        const compiled = [];
        this.compileStatement(bodyStmt, child, compiled, ctx);
        out.push(t.blockStatement(compiled));
      }
    }
  }

  compileNormalForOf(stmt, env, out, ctx) {
    this.compileNormalForOfWithRight(stmt, stmt.right, env, out, ctx);
  }

  compileNormalForOfWithRight(stmt, rightNode, env, out, ctx) {
    const right = this.compileExpression(rightNode, env, ctx);
    const id = stmt.left.declarations?.[0]?.id ?? stmt.left;
    const child = env.child();
    for (const name of boundNames(id)) {
      child.declare(name, { type: "runtime", kind: "loop" });
    }
    const body = this.compileSubStatement(stmt.body, child, { ...ctx, runtime: true });
    const left = t.isVariableDeclaration(stmt.left)
      ? t.variableDeclaration(stmt.left.kind, [
          t.variableDeclarator(t.cloneNode(id), null),
        ])
      : t.cloneNode(stmt.left);
    out.push(t.forOfStatement(left, right, body));
  }

  compileSwitchMarker(stmt, marker, env, out, ctx) {
    let wildcards = 0;
    for (const c of stmt.cases) {
      if (!c.test || t.isIdentifier(c.test, { name: "_" })) wildcards++;
    }
    if (wildcards > 1) {
      throw new CTError(
        ErrorCodes.SYNTAX,
        "<switch> has more than one wildcard/default case",
        marker.loc,
      );
    }
    const result = this.eval(marker.args[0], env);
    if (result.ok) {
      const discriminant = result.value;
      let start = -1;
      let defaultIndex = -1;
      for (let i = 0; i < stmt.cases.length; i++) {
        const c = stmt.cases[i];
        if (!c.test) {
          defaultIndex = i;
          continue;
        }
        if (t.isIdentifier(c.test, { name: "_" })) {
          if (start < 0) start = i;
          continue;
        }
        const value = this.eval(c.test, env);
        if (!value.ok) {
          throw new CTError(
            ErrorCodes.RUNTIME_IN_COMPILE_TIME,
            `<switch> case is not compile-time: ${value.reason}`,
            c.loc?.start ?? marker.loc,
          );
        }
        if (start < 0 && value.value === discriminant) start = i;
      }
      if (start < 0) start = defaultIndex;
      if (start < 0) return;
      const compiled = [];
      for (let i = start; i < stmt.cases.length; i++) {
        let broke = false;
        for (const s of stmt.cases[i].consequent) {
          if (t.isBreakStatement(s)) {
            broke = true;
            break;
          }
          this.compileStatement(s, env, compiled, ctx);
        }
        if (broke) break;
      }
      if (compiled.length > 0) out.push(t.blockStatement(compiled));
      return;
    }

    const discriminant = this.compileExpression(marker.args[0], env, {
      ...ctx,
      runtime: true,
    });
    const child = env.child();
    let hasDefault = false;
    const cases = [];
    for (const c of stmt.cases) {
      let test = null;
      if (c.test) {
        if (t.isIdentifier(c.test, { name: "_" })) {
          if (hasDefault) {
            throw new CTError(
              ErrorCodes.SYNTAX,
              "<switch> has more than one wildcard/default case",
              c.loc?.start ?? marker.loc,
            );
          }
          hasDefault = true;
          test = null;
        } else {
          test = this.compileExpression(c.test, child, { ...ctx, runtime: true });
        }
      } else {
        if (hasDefault) {
          throw new CTError(
            ErrorCodes.SYNTAX,
            "<switch> has more than one wildcard/default case",
            c.loc?.start ?? marker.loc,
          );
        }
        hasDefault = true;
      }
      const consequent = [];
      for (const s of c.consequent) {
        this.compileStatement(s, child, consequent, { ...ctx, runtime: true });
      }
      cases.push(t.switchCase(test, consequent));
    }
    out.push(t.switchStatement(discriminant, cases));
  }

  compileNormalSwitch(stmt, env, out, ctx) {
    const discriminant = this.compileExpression(stmt.discriminant, env, ctx);
    const child = env.child();
    const cases = stmt.cases.map((c) =>
      t.switchCase(
        c.test ? this.compileExpression(c.test, child, ctx) : null,
        c.consequent.flatMap((s) => {
          const inner = [];
          this.compileStatement(s, child, inner, ctx);
          return inner;
        }),
      ),
    );
    out.push(t.switchStatement(discriminant, cases));
  }

  compileFunction(node, env, ctx) {
    const child = env.child();
    const params = node.params.map((param) => {
      for (const name of boundNames(param)) {
        child.declare(name, { type: "runtime", kind: "param" });
      }
      return t.cloneNode(param);
    });
    const body = this.compileBlock(node.body.body, child, {
      ...ctx,
      runtime: true,
      topLevel: false,
    });
    body.directives = cloneDirectives(node.body);
    const fn = t.functionDeclaration(t.cloneNode(node.id), params, body, node.generator, node.async);
    fn.returnType = node.returnType;
    fn.typeParameters = node.typeParameters;
    return fn;
  }

  compileClass(node, env, ctx) {
    const child = env.child();
    if (node.id) child.declare(node.id.name, { type: "runtime", kind: "class" });
    const body = node.body.body.map((member) => {
      if (t.isClassPrivateProperty(member)) {
        return t.classPrivateProperty(
          t.cloneNode(member.key),
          member.value ? this.compileExpression(member.value, child, ctx) : null,
          member.decorators,
          member.static,
        );
      }
      if (t.isClassProperty(member)) {
        return t.classProperty(
          member.computed ? this.compileExpression(member.key, child, ctx) : t.cloneNode(member.key),
          member.value ? this.compileExpression(member.value, child, ctx) : null,
          member.typeAnnotation,
          member.decorators,
          member.computed,
          member.static,
        );
      }
      if (t.isClassMethod(member) || t.isClassPrivateMethod(member)) {
        const methodEnv = child.child();
        const params = member.params.map((param) => {
          for (const name of boundNames(param)) {
            methodEnv.declare(name, { type: "runtime", kind: "param" });
          }
          return t.cloneNode(param);
        });
        return t.classMethod(
          member.kind,
          t.cloneNode(member.key),
          params,
          (() => {
            const methodBody = this.compileBlock(member.body.body, methodEnv, {
              ...ctx,
              runtime: true,
            });
            methodBody.directives = cloneDirectives(member.body);
            return methodBody;
          })(),
          member.computed,
          member.static,
          member.generator,
          member.async,
        );
      }
      return t.cloneNode(member);
    });
    return t.classDeclaration(
      node.id ? t.cloneNode(node.id) : null,
      node.superClass ? this.compileExpression(node.superClass, env, ctx) : null,
      t.classBody(body),
      node.decorators,
    );
  }

  compileExpression(node, env, ctx) {
    const marker = markerOf(node);
    if (marker?.kind === "await") {
      if (ctx.runtime) {
        throw new CTError(
          ErrorCodes.STAGE_LEAK,
          "<await> cannot appear inside a runtime branch or function",
          marker.loc,
        );
      }
      const result = this.eval(marker.args[0], env);
      if (!result.ok) {
        throw new CTError(
          ErrorCodes.NOT_COMPILE_TIME,
          `<await> expression is not compile-time: ${result.reason}`,
          marker.loc,
        );
      }
      if (isThenable(result.value)) {
        throw new CTError(
          ErrorCodes.AWAIT_ASYNC,
          "<await> received a Promise; compile-time APIs must be synchronous in this build",
          marker.loc,
        );
      }
      return valueToNode(result.value, marker.loc);
    }
    if (marker) {
      throw new CTError(
        ErrorCodes.UNSUPPORTED,
        `<${marker.kind}> is not valid in this expression position`,
        marker.loc,
      );
    }

    if (t.isThisExpression(node)) return t.thisExpression();
    if (t.isSuper(node)) return t.super();
    if (t.isMetaProperty(node)) return t.cloneNode(node);
    if (t.isIdentifier(node)) {
      const binding = env.lookup(node.name);
      if (binding?.type === "ct") {
        if (binding.value instanceof CTFunctionGroup) {
          binding.value.usedRuntime = true;
          const imported = this.ctImports.get(node.name);
          if (imported) this.runtimeImports.set(node.name, imported);
          return t.identifier(node.name);
        }
        return valueToNode(binding.value, node.loc?.start ?? null);
      }
      if (!binding && this.groups.has(node.name)) {
        const group = this.groups.get(node.name);
        group.usedRuntime = true;
        return t.identifier(node.name);
      }
      return t.identifier(node.name);
    }

    if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
      if (
        (t.isMemberExpression(node.callee) || t.isOptionalMemberExpression(node.callee)) &&
        this.isCompileTimeCallee(node.callee, env)
      ) {
        if (ctx.runtime) {
          throw new CTError(
            ErrorCodes.STAGE_LEAK,
            "A compile-time API call cannot appear inside a runtime branch",
            node.loc?.start ?? null,
            "Move the call to a compile-time context, or use a runtime function instead.",
          );
        }
        const result = this.eval(node, env);
        if (!result.ok) {
          throw new CTError(
            ErrorCodes.RUNTIME_ARG_IN_COMPILE_TIME,
            `Compile-time API call is not fully compile-time: ${result.reason}`,
            node.loc?.start ?? null,
            "Arguments to compile-time APIs must be compile-time values.",
          );
        }
        return valueToNode(result.value, node.loc?.start ?? null);
      }
      const groupName = t.isIdentifier(node.callee) ? node.callee.name : null;
      const binding = groupName ? env.lookup(groupName) : null;
      const group =
        groupName && binding?.type === "ct" && binding.value instanceof CTFunctionGroup
          ? binding.value
          : groupName && !binding
            ? this.groups.get(groupName)
            : null;
      if (group) {
        const evaluatedArgs = [];
        let allKnown = true;
        for (const arg of node.arguments) {
          if (t.isSpreadElement(arg)) {
            allKnown = false;
            break;
          }
          const result = this.eval(arg, env);
          if (!result.ok) {
            allKnown = false;
            break;
          }
          evaluatedArgs.push(result.value);
        }
        if (allKnown) {
          return valueToNode(this.callGroup(group, evaluatedArgs, node.loc?.start ?? null), node.loc?.start ?? null);
        }
        group.usedRuntime = true;
        const imported = this.ctImports.get(groupName);
        if (imported) this.runtimeImports.set(groupName, imported);
        const args = node.arguments.map((arg) =>
          t.isSpreadElement(arg)
            ? t.spreadElement(this.compileExpression(arg.argument, env, ctx))
            : this.compileExpression(arg, env, ctx),
        );
        return t.callExpression(t.identifier(groupName), args);
      }
      if (groupName && binding?.type === "ct") {
        const fn = binding.value;
        if (typeof fn !== "function" && !(fn && typeof fn.call === "function")) {
          // Not a callable compile-time value; fall through to normal call.
        } else {
          if (ctx.runtime) {
            throw new CTError(
              ErrorCodes.STAGE_LEAK,
              `Compile-time function '${groupName}' cannot be called inside a runtime branch`,
              node.loc?.start ?? null,
            );
          }
          const args = [];
          for (const arg of node.arguments) {
            if (t.isSpreadElement(arg)) {
              const spread = this.eval(arg.argument, env);
              if (!spread.ok || !isIterable(spread.value)) {
                throw new CTError(
                  ErrorCodes.RUNTIME_ARG_IN_COMPILE_TIME,
                  `Compile-time function '${groupName}' was called with a non-compile-time spread argument`,
                  node.loc?.start ?? null,
                  "All arguments to a compile-time call must be compile-time values.",
                );
              }
              args.push(...spread.value);
              continue;
            }
            const result = this.eval(arg, env);
            if (!result.ok) {
              throw new CTError(
                ErrorCodes.RUNTIME_ARG_IN_COMPILE_TIME,
                `Compile-time function '${groupName}' was called with a runtime argument`,
                node.loc?.start ?? null,
                "All arguments to a compile-time call must be compile-time values.",
              );
            }
            args.push(result.value);
          }
          const value = Reflect.apply(fn, undefined, args);
          if (isThenable(value)) {
            throw new CTError(ErrorCodes.AWAIT_ASYNC, "Compile-time API returned a Promise", node.loc?.start ?? null);
          }
          return valueToNode(value, node.loc?.start ?? null);
        }
      }
    }

    if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
      const callee = this.compileExpression(node.callee, env, ctx);
      const args = node.arguments.map((arg) =>
        t.isSpreadElement(arg)
          ? t.spreadElement(this.compileExpression(arg.argument, env, ctx))
          : this.compileExpression(arg, env, ctx),
      );
      if (t.isOptionalCallExpression(node)) {
        return t.optionalCallExpression(callee, args, node.optional);
      }
      return t.callExpression(callee, args);
    }
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
      const evaluatedObject = this.eval(node.object, env);
      if (evaluatedObject.ok && this.isCompileTimeObject(node.object, env)) {
        let key;
        if (node.computed) {
          const prop = this.eval(node.property, env);
          if (!prop.ok) {
            throw new CTError(
              ErrorCodes.RUNTIME_IN_COMPILE_TIME,
              `Compile-time member access has a runtime key: ${prop.reason}`,
              node.loc?.start ?? null,
            );
          }
          key = prop.value;
        } else {
          key = node.property.name ?? node.property.value;
        }
        const value = evaluatedObject.value?.[key];
        return valueToNode(value, node.loc?.start ?? null);
      }
      const object = this.compileExpression(node.object, env, ctx);
      const property = node.computed
        ? this.compileExpression(node.property, env, ctx)
        : node.property;
      return t.memberExpression(object, property, node.computed, node.optional);
    }
    if (t.isLogicalExpression(node)) {
      return t.logicalExpression(
        node.operator,
        this.compileExpression(node.left, env, ctx),
        this.compileExpression(node.right, env, ctx),
      );
    }
    if (t.isBinaryExpression(node)) {
      return t.binaryExpression(
        node.operator,
        this.compileExpression(node.left, env, ctx),
        this.compileExpression(node.right, env, ctx),
      );
    }
    if (t.isAssignmentExpression(node)) {
      if (t.isIdentifier(node.left)) {
        const binding = env.lookup(node.left.name);
        if (binding?.type === "ct") {
          throw new CTError(
            ErrorCodes.RUNTIME_IN_CONST,
            `Cannot assign to compile-time binding '${node.left.name}'`,
            node.loc?.start ?? null,
          );
        }
      }
      return t.assignmentExpression(
        node.operator,
        this.compileExpression(node.left, env, ctx),
        this.compileExpression(node.right, env, ctx),
      );
    }
    if (t.isUpdateExpression(node)) {
      if (t.isIdentifier(node.argument)) {
        const binding = env.lookup(node.argument.name);
        if (binding?.type === "ct") {
          throw new CTError(
            ErrorCodes.RUNTIME_IN_CONST,
            `Cannot update compile-time binding '${node.argument.name}'`,
            node.loc?.start ?? null,
          );
        }
      }
      return t.updateExpression(
        node.operator,
        this.compileExpression(node.argument, env, ctx),
        node.prefix,
      );
    }
    if (t.isUnaryExpression(node)) {
      return t.unaryExpression(
        node.operator,
        this.compileExpression(node.argument, env, ctx),
        node.prefix,
      );
    }
    if (t.isConditionalExpression(node)) {
      return t.conditionalExpression(
        this.compileExpression(node.test, env, ctx),
        this.compileExpression(node.consequent, env, ctx),
        this.compileExpression(node.alternate, env, ctx),
      );
    }
    if (t.isSequenceExpression(node)) {
      return t.sequenceExpression(
        node.expressions.map((expr) => this.compileExpression(expr, env, ctx)),
      );
    }
    if (t.isTemplateLiteral(node)) {
      return t.templateLiteral(
        node.quasis.map((q) => t.cloneNode(q)),
        node.expressions.map((expr) => this.compileExpression(expr, env, ctx)),
      );
    }
    if (t.isArrayExpression(node)) {
      return t.arrayExpression(
        node.elements.map((element) => {
          if (!element) return null;
          if (t.isSpreadElement(element)) {
            return t.spreadElement(this.compileExpression(element.argument, env, ctx));
          }
          return this.compileExpression(element, env, ctx);
        }),
      );
    }
    if (t.isObjectExpression(node)) {
      return t.objectExpression(
        node.properties.map((prop) => {
          if (t.isSpreadElement(prop)) {
            return t.spreadElement(this.compileExpression(prop.argument, env, ctx));
          }
          if (t.isObjectProperty(prop)) {
            return t.objectProperty(
              prop.computed ? this.compileExpression(prop.key, env, ctx) : t.cloneNode(prop.key),
              this.compileExpression(prop.value, env, ctx),
              prop.computed,
              false,
              prop.decorators,
            );
          }
          if (t.isObjectMethod(prop)) {
            const child = env.child();
            const params = prop.params.map((param) => {
              for (const name of boundNames(param)) {
                child.declare(name, { type: "runtime", kind: "param" });
              }
              return t.cloneNode(param);
            });
            return t.objectMethod(
              prop.kind,
              prop.computed ? this.compileExpression(prop.key, env, ctx) : t.cloneNode(prop.key),
              params,
              (() => {
                const methodBody = this.compileBlock(prop.body.body, child, {
                  ...ctx,
                  runtime: true,
                });
                methodBody.directives = cloneDirectives(prop.body);
                return methodBody;
              })(),
              prop.computed,
              prop.generator,
              prop.async,
            );
          }
          return t.cloneNode(prop);
        }),
      );
    }
    if (t.isArrowFunctionExpression(node) || t.isFunctionExpression(node)) {
      const child = env.child();
      const params = node.params.map((param) => {
        for (const name of boundNames(param)) {
          child.declare(name, { type: "runtime", kind: "param" });
        }
        return t.cloneNode(param);
      });
      const body = t.isBlockStatement(node.body)
        ? (() => {
            const fnBody = this.compileBlock(node.body.body, child, {
              ...ctx,
              runtime: true,
            });
            fnBody.directives = cloneDirectives(node.body);
            return fnBody;
          })()
        : this.compileExpression(node.body, child, { ...ctx, runtime: true });
      if (t.isArrowFunctionExpression(node)) {
        return t.arrowFunctionExpression(params, body, node.async);
      }
      return t.functionExpression(
        node.id ? t.cloneNode(node.id) : null,
        params,
        t.isBlockStatement(body) ? body : t.blockStatement([t.returnStatement(body)]),
        node.generator,
        node.async,
      );
    }
    if (t.isNewExpression(node)) {
      return t.newExpression(
        this.compileExpression(node.callee, env, ctx),
        node.arguments.map((arg) =>
          t.isSpreadElement(arg)
            ? t.spreadElement(this.compileExpression(arg.argument, env, ctx))
            : this.compileExpression(arg, env, ctx),
        ),
      );
    }
    if (t.isAwaitExpression(node)) {
      return t.awaitExpression(this.compileExpression(node.argument, env, ctx));
    }
    if (t.isYieldExpression(node)) {
      return t.yieldExpression(
        node.argument ? this.compileExpression(node.argument, env, ctx) : null,
        node.delegate,
      );
    }
    if (t.isTaggedTemplateExpression(node)) {
      return t.taggedTemplateExpression(
        this.compileExpression(node.tag, env, ctx),
        this.compileExpression(node.quasi, env, ctx),
      );
    }
    if (
      t.isStringLiteral(node) ||
      t.isNumericLiteral(node) ||
      t.isBooleanLiteral(node) ||
      t.isNullLiteral(node) ||
      t.isBigIntLiteral(node) ||
      t.isRegExpLiteral(node)
    ) {
      return t.cloneNode(node);
    }
    throw new CTError(
      ErrorCodes.UNSUPPORTED,
      `Unsupported expression: ${node.type}`,
      node.loc?.start ?? null,
    );
  }

  compileRuntimeGroup(group) {
    const out = [];
    this.helpers.add("noMatch");
    for (const clause of group.clauses) {
      const child = this.global.child();
      const params = clause.params.map((param) => {
        for (const name of boundNames(param)) {
          child.declare(name, { type: "runtime", kind: "param" });
        }
        return t.cloneNode(param);
      });
      const body = [];
      if (clause.guard && !t.isBooleanLiteral(clause.guard, { value: true })) {
        const guard = this.compileExpression(clause.guard, child, {
          runtime: true,
          topLevel: false,
        });
        body.push(
          t.ifStatement(
            t.unaryExpression("!", guard),
            t.returnStatement(t.identifier(NO_MATCH)),
          ),
        );
      }
      for (const stmt of clause.body) {
        this.compileStatement(stmt, child, body, { runtime: true, topLevel: false });
      }
      out.push(
        t.functionDeclaration(
          t.identifier(`__ctjs_clause_${clause.id}__${group.name}`),
          params,
          t.blockStatement(body),
        ),
      );
    }

    const argsId = t.identifier("__ctjs_args");
    const resultId = t.identifier("__ctjs_result");
    const statements = [
      t.variableDeclaration("let", [t.variableDeclarator(t.cloneNode(resultId), null)]),
    ];
    for (const clause of group.clauses) {
      statements.push(
        t.expressionStatement(
          t.assignmentExpression(
            "=",
            t.cloneNode(resultId),
            t.callExpression(
              t.identifier(`__ctjs_clause_${clause.id}__${group.name}`),
              [t.spreadElement(t.cloneNode(argsId))],
            ),
          ),
        ),
      );
      statements.push(
        t.ifStatement(
          t.binaryExpression(
            "!==",
            t.cloneNode(resultId),
            t.identifier(NO_MATCH),
          ),
          t.returnStatement(t.cloneNode(resultId)),
        ),
      );
    }
    statements.push(
      t.throwStatement(
        t.newExpression(t.identifier("Error"), [
          t.stringLiteral(`No matching <fn> clause for '${group.name}'`),
        ]),
      ),
    );
    const dispatcher = t.functionDeclaration(
      t.identifier(group.name),
      [t.restElement(t.cloneNode(argsId))],
      t.blockStatement(statements),
    );
    if (group.exported) {
      out.push(t.exportNamedDeclaration(dispatcher, []));
    } else {
      out.push(dispatcher);
    }
    return out;
  }
}


function findMarker(node, kind) {
  let found = null;
  const visit = (value) => {
    if (found || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const marker = markerOf(value);
    if (marker?.kind === kind) {
      found = marker;
      return;
    }
    for (const key of Object.keys(value)) {
      if (key === "loc" || key === "start" || key === "end" || key === "range") continue;
      visit(value[key]);
    }
  };
  visit(node);
  return found;
}

function containsLoopControl(node) {
  let found = false;
  const visit = (value) => {
    if (found || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value.type === "BreakStatement" || value.type === "ContinueStatement") {
      found = true;
      return;
    }
    // Do not descend into nested loops or functions: their break/continue
    // belongs to them, not to the macro loop.
    if (
      value !== node &&
      (value.type === "ForStatement" ||
        value.type === "ForOfStatement" ||
        value.type === "ForInStatement" ||
        value.type === "WhileStatement" ||
        value.type === "DoWhileStatement" ||
        value.type === "FunctionDeclaration" ||
        value.type === "FunctionExpression" ||
        value.type === "ArrowFunctionExpression")
    ) {
      return;
    }
    for (const key of Object.keys(value)) {
      if (key === "loc" || key === "start" || key === "end" || key === "range") continue;
      visit(value[key]);
    }
  };
  visit(node);
  return found;
}
