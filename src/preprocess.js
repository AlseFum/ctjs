/**
 * Source-level desugaring for the `<if>`, `<const>`, ... macro syntax.
 *
 * Babel cannot parse `<if>(x) { ... }` as JavaScript, so the Babel plugin
 * rewrites the source into valid JavaScript containing marker calls before
 * handing it to @babel/parser.  Every rewrite keeps the number of newlines
 * unchanged and records the original source position in the marker call, so
 * diagnostics still point at the macro the user wrote.
 *
 * The output of this module is an implementation detail of the Babel plugin.
 */

export const MARKER = "__ctjs_macro__";
export const CLAUSE_MARKER = "__ctjs_clause__";
export const NO_MATCH = "__ctjs_no_match__";

const KEYWORDS = new Set([
  "if",
  "else",
  "for",
  "switch",
  "const",
  "await",
  "fn",
  "export",
  "import",
]);

const REGEX_PREFIX_WORDS = new Set([
  "return",
  "throw",
  "case",
  "delete",
  "void",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "else",
  "do",
  "yield",
  "await",
]);

class MacroSyntaxError extends Error {
  constructor(message, loc) {
    super(message);
    this.name = "MacroSyntaxError";
    this.code = "CT1000";
    this.loc = loc;
  }
}

/**
 * Rewrite macro syntax into marker calls.
 *
 * @param {string} source
 * @returns {{code: string, macros: Array<object>}}
 */
export function desugarMacros(source) {
  let nextId = 0;
  const macros = [];
  const lineStarts = computeLineStarts(source);

  function locAt(offset) {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lineStarts[mid] <= offset) lo = mid + 1;
      else hi = mid - 1;
    }
    const line = Math.max(1, hi + 1);
    const column = offset - lineStarts[Math.max(0, hi)];
    return { line, column };
  }

  function fail(message, offset) {
    throw new MacroSyntaxError(message, locAt(offset));
  }

  function newId(offset, kind) {
    const id = nextId++;
    macros.push({ id, kind, loc: locAt(offset) });
    return id;
  }

  function marker(kind, offset, payload) {
    const id = newId(offset, kind);
    const { line, column } = locAt(offset);
    return `${MARKER}(${JSON.stringify(kind)}, ${id}, ${line}, ${column}${
      payload === undefined ? "" : `, ${payload}`
    })`;
  }

  function skipSpaceAndComments(pos, limit) {
    while (pos < limit) {
      const ch = source[pos];
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        pos++;
      } else if (ch === "/" && source[pos + 1] === "/") {
        pos += 2;
        while (pos < limit && source[pos] !== "\n") pos++;
      } else if (ch === "/" && source[pos + 1] === "*") {
        pos += 2;
        while (pos < limit && !(source[pos] === "*" && source[pos + 1] === "/")) {
          pos++;
        }
        if (pos >= limit) fail("Unterminated block comment", pos);
        pos += 2;
      } else {
        break;
      }
    }
    return pos;
  }

  function skipString(pos, limit) {
    const quote = source[pos];
    pos++;
    while (pos < limit) {
      if (source[pos] === "\\") {
        pos += 2;
      } else if (source[pos] === quote) {
        return pos + 1;
      } else {
        pos++;
      }
    }
    return limit;
  }

  function skipTemplate(pos, limit) {
    // `pos` points at the opening backtick.
    pos++;
    while (pos < limit) {
      if (source[pos] === "\\") {
        pos += 2;
      } else if (source[pos] === "`") {
        return pos + 1;
      } else if (source[pos] === "$" && source[pos + 1] === "{") {
        const close = findMatching(pos + 1, limit);
        if (close < 0) return limit;
        pos = close + 1;
      } else {
        pos++;
      }
    }
    return limit;
  }

  function skipRegex(pos, limit) {
    // `pos` points at the opening slash.
    pos++;
    let inClass = false;
    while (pos < limit) {
      const ch = source[pos];
      if (ch === "\\") {
        pos += 2;
      } else if (ch === "[") {
        inClass = true;
        pos++;
      } else if (ch === "]") {
        inClass = false;
        pos++;
      } else if (ch === "/" && !inClass) {
        pos++;
        while (pos < limit && /[a-z]/i.test(source[pos])) pos++;
        return pos;
      } else if (ch === "\n") {
        return pos;
      } else {
        pos++;
      }
    }
    return limit;
  }

  function previousSignificant(pos, limit) {
    let i = pos - 1;
    while (i >= 0) {
      const ch = source[i];
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        i--;
      } else {
        break;
      }
    }
    if (i < 0) return { char: "", word: "" };
    if (/[A-Za-z0-9_$]/.test(source[i])) {
      let end = i + 1;
      while (i >= 0 && /[A-Za-z0-9_$]/.test(source[i])) i--;
      return { char: "", word: source.slice(i + 1, end) };
    }
    return { char: source[i], word: "" };
  }

  function looksLikeRegex(pos) {
    const prev = previousSignificant(pos, source.length);
    if (prev.word) return REGEX_PREFIX_WORDS.has(prev.word);
    return "([{=,:;!&|?+-*%^~<>".includes(prev.char);
  }

  /**
   * Find the closing delimiter matching the opener at `openPos`.
   * Handles all bracket kinds, strings, comments, templates and regexes.
   */
  function findMatching(openPos, limit) {
    const open = source[openPos];
    const close = open === "(" ? ")" : open === "[" ? "]" : open === "{" ? "}" : null;
    if (!close) return -1;
    const stack = [close];
    let pos = openPos + 1;
    while (pos < limit) {
      const ch = source[pos];
      if (ch === "'" || ch === '"') {
        pos = skipString(pos, limit);
      } else if (ch === "`") {
        pos = skipTemplate(pos, limit);
      } else if (ch === "/" && source[pos + 1] === "/") {
        pos += 2;
        while (pos < limit && source[pos] !== "\n") pos++;
      } else if (ch === "/" && source[pos + 1] === "*") {
        pos += 2;
        while (pos < limit && !(source[pos] === "*" && source[pos + 1] === "/")) pos++;
        pos = Math.min(limit, pos + 2);
      } else if (ch === "/" && looksLikeRegex(pos)) {
        pos = skipRegex(pos, limit);
      } else if (ch === "(" || ch === "[" || ch === "{") {
        stack.push(ch === "(" ? ")" : ch === "[" ? "]" : "}");
        pos++;
      } else if (stack.length > 0 && ch === stack[stack.length - 1]) {
        stack.pop();
        pos++;
        if (stack.length === 0) return pos - 1;
      } else {
        pos++;
      }
    }
    return -1;
  }

  /**
   * Scan an expression until a top-level stop character.
   */
  function findExpressionEnd(start, limit, stops = [";", "\n", "}", ")", "]", ","]) {
    let pos = start;
    while (pos < limit) {
      const ch = source[pos];
      if (ch === "'" || ch === '"') {
        pos = skipString(pos, limit);
        continue;
      }
      if (ch === "`") {
        pos = skipTemplate(pos, limit);
        continue;
      }
      if (ch === "/" && source[pos + 1] === "/") {
        // A line comment ends the expression at the newline, which the
        // newline stop will handle.
        pos += 2;
        while (pos < limit && source[pos] !== "\n") pos++;
        continue;
      }
      if (ch === "/" && source[pos + 1] === "*") {
        pos += 2;
        while (pos < limit && !(source[pos] === "*" && source[pos + 1] === "/")) pos++;
        pos = Math.min(limit, pos + 2);
        continue;
      }
      if (ch === "/" && looksLikeRegex(pos)) {
        pos = skipRegex(pos, limit);
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") {
        const close = findMatching(pos, limit);
        if (close < 0) return -1;
        pos = close + 1;
        continue;
      }
      if (stops.includes(ch)) return pos;
      pos++;
    }
    return limit;
  }

  function splitTopLevel(text, delimiter = ",") {
    const parts = [];
    let start = 0;
    let pos = 0;
    while (pos < text.length) {
      const ch = text[pos];
      if (ch === "'" || ch === '"') {
        pos = skipStringIn(text, pos);
      } else if (ch === "`") {
        pos = skipTemplateIn(text, pos);
      } else if (ch === "(" || ch === "[" || ch === "{") {
        const close = findMatchingIn(text, pos);
        pos = close < 0 ? text.length : close + 1;
      } else if (ch === delimiter) {
        parts.push(text.slice(start, pos));
        start = pos + 1;
        pos++;
      } else {
        pos++;
      }
    }
    parts.push(text.slice(start));
    return parts;
  }

  function skipStringIn(text, pos) {
    const quote = text[pos];
    pos++;
    while (pos < text.length) {
      if (text[pos] === "\\") pos += 2;
      else if (text[pos] === quote) return pos + 1;
      else pos++;
    }
    return text.length;
  }

  function skipTemplateIn(text, pos) {
    pos++;
    while (pos < text.length) {
      if (text[pos] === "\\") pos += 2;
      else if (text[pos] === "`") return pos + 1;
      else if (text[pos] === "$" && text[pos + 1] === "{") {
        const close = findMatchingIn(text, pos + 1);
        pos = close < 0 ? text.length : close + 1;
      } else pos++;
    }
    return text.length;
  }

  function findMatchingIn(text, openPos) {
    const open = text[openPos];
    const close = open === "(" ? ")" : open === "[" ? "]" : open === "{" ? "}" : null;
    if (!close) return -1;
    const stack = [close];
    let pos = openPos + 1;
    while (pos < text.length) {
      const ch = text[pos];
      if (ch === "'" || ch === '"') pos = skipStringIn(text, pos);
      else if (ch === "`") pos = skipTemplateIn(text, pos);
      else if (ch === "(" || ch === "[" || ch === "{") {
        stack.push(ch === "(" ? ")" : ch === "[" ? "]" : "}");
        pos++;
      } else if (ch === stack[stack.length - 1]) {
        stack.pop();
        pos++;
        if (stack.length === 0) return pos - 1;
      } else pos++;
    }
    return -1;
  }

  function parseFunctionHeader(tagOffset, tagName, exported, tagPos = tagOffset) {
    let pos = skipSpaceAndComments(tagOffset, source.length);
    const nameMatch = /^[A-Za-z_$][\w$]*/.exec(source.slice(pos));
    if (!nameMatch) fail("Expected a function name after <fn>", pos);
    const fnName = nameMatch[0];
    pos += fnName.length;
    pos = skipSpaceAndComments(pos, source.length);
    if (source[pos] !== "(") fail("Expected '(' after <fn> function name", pos);
    const closeParen = findMatching(pos, source.length);
    if (closeParen < 0) fail("Unterminated <fn> parameter list", pos);
    const paramsText = source.slice(pos + 1, closeParen);
    pos = skipSpaceAndComments(closeParen + 1, source.length);
    if (source[pos] !== "{") fail("Expected '{' after <fn> parameter list", pos);

    const id = newId(tagPos, "fn");
    const clauseName = `__ctjs_clause_${id}__${fnName}`;
    const rawParams = splitTopLevel(paramsText).map((s) => s.trim()).filter(Boolean);
    const params = [];
    const guards = [];
    const seen = new Set();

    for (let i = 0; i < rawParams.length; i++) {
      const raw = rawParams[i];
      if (raw.startsWith("...")) {
        const rest = raw.slice(3).trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(rest)) {
          fail("Unsupported rest parameter pattern in <fn>", pos);
        }
        if (seen.has(rest)) fail(`Duplicate parameter '${rest}' in <fn>`, pos);
        seen.add(rest);
        params.push(`...${rest}`);
        continue;
      }

      if (/^[A-Za-z_$][\w$]*$/.test(raw)) {
        if (seen.has(raw)) fail(`Duplicate parameter '${raw}' in <fn>`, pos);
        seen.add(raw);
        params.push(raw);
        continue;
      }

      if (raw === "_") {
        const name = `__ctjs_ignored_${id}_${i}`;
        params.push(name);
        continue;
      }

      // `<fn arg> fun(arg == 1, ...)` -- a guard over a named parameter.
      const guardMatch =
        /^([A-Za-z_$][\w$]*)\s*(===|!==|==|!=|>=|<=|>|<)\s*([\s\S]+)$/.exec(raw);
      if (guardMatch) {
        const [, name, op, rhs] = guardMatch;
        if (seen.has(name)) fail(`Duplicate parameter '${name}' in <fn>`, pos);
        seen.add(name);
        params.push(name);
        guards.push(`${name} ${op} (${rhs.trim()})`);
        continue;
      }

      // A literal pattern such as `fun(1)` or `fun("x")`.
      if (/^(?:-?\d|["'`]|true\b|false\b|null\b|undefined\b)/.test(raw)) {
        const name = `__ctjs_pattern_${id}_${i}`;
        params.push(name);
        guards.push(`${name} === (${raw})`);
        continue;
      }

      // Fall back to using the tag name as the bound variable.  This makes
      // `<fn arg> fun(arg > 0)` work; anything else is rejected.
      if (tagName && /^[A-Za-z_$][\w$]*$/.test(tagName)) {
        if (seen.has(tagName)) fail(`Duplicate parameter '${tagName}' in <fn>`, pos);
        seen.add(tagName);
        params.push(tagName);
        guards.push(raw);
        continue;
      }

      fail(`Unsupported parameter pattern in <fn>: ${raw}`, pos);
    }

    const guard = guards.length === 0 ? "true" : guards.join(" && ");
    const exportArg = exported ? "true" : "false";
    const prelude =
      `${CLAUSE_MARKER}(${JSON.stringify(fnName)}, ${id}, ${locAt(tagPos).line}, ` +
      `${locAt(tagPos).column}, ${exportArg}); ` +
      `if (!(${guard})) return ${NO_MATCH}; `;

    return {
      clauseName,
      fnName,
      params,
      prelude,
      bodyStart: pos, // points at "{"
      id,
    };
  }

  function rewrite(start, end) {
    let out = "";
    let pos = start;
    while (pos < end) {
      const ch = source[pos];

      if (ch === "'" || ch === '"') {
        const next = skipString(pos, end);
        out += source.slice(pos, next);
        pos = next;
        continue;
      }
      if (ch === "`") {
        const next = skipTemplate(pos, end);
        out += source.slice(pos, next);
        pos = next;
        continue;
      }
      if (ch === "/" && source[pos + 1] === "/") {
        const next = source.indexOf("\n", pos);
        const stop = next < 0 || next >= end ? end : next;
        out += source.slice(pos, stop);
        pos = stop;
        continue;
      }
      if (ch === "/" && source[pos + 1] === "*") {
        const close = source.indexOf("*/", pos + 2);
        const stop = close < 0 || close + 2 > end ? end : close + 2;
        out += source.slice(pos, stop);
        pos = stop;
        continue;
      }
      if (ch === "/" && looksLikeRegex(pos)) {
        const next = skipRegex(pos, end);
        out += source.slice(pos, next);
        pos = next;
        continue;
      }

      if (ch === "<") {
        const tag = /^<([a-z]+)([^>]*)>/.exec(source.slice(pos, Math.min(end, pos + 128)));
        if (tag && KEYWORDS.has(tag[1])) {
          const kind = tag[1];
          const tagEnd = pos + tag[0].length;
          const line = locAt(pos).line;
          const column = locAt(pos).column;

          if (kind === "else") {
            out += "else ";
            pos = tagEnd;
            continue;
          }

          if (kind === "if") {
            let p = skipSpaceAndComments(tagEnd, end);
            if (source[p] !== "(") fail("Expected '(' after <if>", p);
            const close = findMatching(p, end);
            if (close < 0) fail("Unterminated <if> condition", p);
            const cond = rewrite(p + 1, close);
            out += `if (${marker("if", pos, `(${cond})`)}) `;
            pos = close + 1;
            continue;
          }

          if (kind === "for") {
            let p = skipSpaceAndComments(tagEnd, end);
            if (source[p] !== "(") fail("Expected '(' after <for>", p);
            const close = findMatching(p, end);
            if (close < 0) fail("Unterminated <for> header", p);
            const header = source.slice(p + 1, close).trim();
            const m = /^(?:(const|let|var)\s+)?([A-Za-z_$][\w$]*)\s+of\s+([\s\S]+)$/.exec(
              header,
            );
            if (!m) fail("Expected `<for>(name of iterable)`", p);
            const [, declKind = "const", name, iterable] = m;
            if (!["const", "let", "var"].includes(declKind)) {
              fail("Unsupported <for> declaration kind", p);
            }
            const iterableStart = p + 1 + header.indexOf(iterable);
            const iterableCode = rewrite(iterableStart, iterableStart + iterable.length);
            out += `for (${declKind} ${name} of ${marker("for", pos, `(${iterableCode})`)}) `;
            pos = close + 1;
            continue;
          }

          if (kind === "switch") {
            let p = skipSpaceAndComments(tagEnd, end);
            if (source[p] !== "(") fail("Expected '(' after <switch>", p);
            const close = findMatching(p, end);
            if (close < 0) fail("Unterminated <switch> expression", p);
            const discriminant = rewrite(p + 1, close);
            out += `switch (${marker("switch", pos, `(${discriminant})`)}) `;
            pos = close + 1;
            continue;
          }

          if (kind === "const") {
            let p = skipSpaceAndComments(tagEnd, end);
            const declStart = p;
            const declEnd = findExpressionEnd(p, end, [";", "\n", "}"]);
            if (declEnd < 0) fail("Unterminated <const> declaration", p);
            let declaration = source.slice(declStart, declEnd);
            if (!declaration.trim()) fail("Expected a declaration after <const>", p);
            const declarators = splitTopLevel(declaration).map((s) => s.trim());
            const pieces = [];
            for (const declarator of declarators) {
              const eq = topLevelEquals(declarator);
              if (eq < 0) fail(`Expected '=' in <const> declaration: ${declarator}`, p);
              const name = declarator.slice(0, eq).trim();
              const init = declarator.slice(eq + 1).trim();
              if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
                fail(`<const> currently supports simple identifiers, got: ${name}`, p);
              }
              if (!init) fail(`Missing initializer for <const> ${name}`, p);
              const initStart = declStart + declaration.indexOf(declarator) + declarator.indexOf(init);
              pieces.push(`${name} = ${marker("const", pos, `(${rewrite(initStart, initStart + init.length)})`)}`);
            }
            out += `const ${pieces.join(", ")};`;
            pos = declEnd;
            if (source[pos] === ";") pos++;
            continue;
          }

          if (kind === "await") {
            let p = skipSpaceAndComments(tagEnd, end);
            const exprStart = p;
            const exprEnd = findExpressionEnd(p, end, [";", "\n", "}", ")", "]", ","]);
            if (exprEnd < 0) fail("Unterminated <await> expression", p);
            const expr = source.slice(exprStart, exprEnd).trim();
            if (!expr) fail("Expected an expression after <await>", p);
            const exprOffset = exprStart + source.slice(exprStart, exprEnd).indexOf(expr);
            out += marker("await", pos, `(${rewrite(exprOffset, exprOffset + expr.length)})`);
            pos = exprEnd;
            continue;
          }

          if (kind === "import") {
            let p = skipSpaceAndComments(tagEnd, end);
            if (source[p] !== "{") fail("Expected '{' after <import>", p);
            const close = findMatching(p, end);
            if (close < 0) fail("Unterminated <import> specifier list", p);
            const specText = source.slice(p + 1, close);
            const specs = splitTopLevel(specText)
              .map((s) => s.trim())
              .filter(Boolean)
              .map((s) => {
                const m = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(s);
                if (!m) fail(`Unsupported <import> specifier: ${s}`, p);
                return { imported: m[1], local: m[2] || m[1] };
              });
            p = skipSpaceAndComments(close + 1, end);
            if (!/^from\b/.test(source.slice(p, p + 8))) {
              fail("Expected 'from' in <import>", p);
            }
            p = skipSpaceAndComments(p + 4, end);
            const quote = source[p];
            if (quote !== '"' && quote !== "'") fail("Expected a module string in <import>", p);
            const strEnd = skipString(p, end);
            const moduleSource = source.slice(p + 1, strEnd - 1);
            out += `${marker("import", pos, `${JSON.stringify(moduleSource)}, ${JSON.stringify(
              specs,
            )}`)};`;
            pos = strEnd;
            // Consume the optional semicolon.
            if (source[pos] === ";") pos++;
            continue;
          }

          if (kind === "export") {
            let p = skipSpaceAndComments(tagEnd, end);
            if (/^<fn\b/.test(source.slice(p, p + 4))) {
              const fnTag = /^<fn([^>]*)>/.exec(source.slice(p, Math.min(end, p + 128)));
              if (!fnTag) fail("Malformed <fn> after <export>", p);
              const header = parseFunctionHeader(
                p + fnTag[0].length,
                fnTag[1].trim(),
                true,
                p,
              );
              out += `function ${header.clauseName}(${header.params.join(", ")}) { ${header.prelude}`;
              pos = header.bodyStart + 1;
              continue;
            }
            const constTag = /^<const>/.exec(source.slice(p, p + 8));
            const constKeyword = /^const\b/.exec(source.slice(p, p + 8));
            if (constTag || constKeyword) {
              const constTagEnd = p + (constTag ? constTag[0].length : constKeyword[0].length);
              let q = skipSpaceAndComments(constTagEnd, end);
              const declStart = q;
              const declEnd = findExpressionEnd(q, end, [";", "\n", "}"]);
              if (declEnd < 0) fail("Unterminated <const> declaration", q);
              const declaration = source.slice(declStart, declEnd);
              const declarators = splitTopLevel(declaration).map((s) => s.trim());
              const pieces = [];
              for (const declarator of declarators) {
                const eq = topLevelEquals(declarator);
                if (eq < 0) fail(`Expected '=' in <const> declaration: ${declarator}`, q);
                const name = declarator.slice(0, eq).trim();
                const init = declarator.slice(eq + 1).trim();
                if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
                  fail(`<const> currently supports simple identifiers, got: ${name}`, q);
                }
                if (!init) fail(`Missing initializer for <const> ${name}`, q);
                const initStart = declStart + declaration.indexOf(declarator) + declarator.indexOf(init);
                pieces.push(
                  `${name} = ${marker("export-const", p, `(${rewrite(initStart, initStart + init.length)})`)}`,
                );
              }
              out += `const ${pieces.join(", ")};`;
              pos = declEnd;
              if (source[pos] === ";") pos++;
              continue;
            }
            fail("<export> must be followed by <const> or <fn>", p);
          }

          if (kind === "fn") {
            const tagName = tag[2].trim();
            const header = parseFunctionHeader(tagEnd, tagName, false, pos);
            out += `function ${header.clauseName}(${header.params.join(", ")}) { ${header.prelude}`;
            pos = header.bodyStart + 1;
            continue;
          }
        }
      }

      out += ch;
      pos++;
    }
    return out;
  }

  function topLevelEquals(text) {
    let pos = 0;
    while (pos < text.length) {
      const ch = text[pos];
      if (ch === "'" || ch === '"') pos = skipStringIn(text, pos);
      else if (ch === "`") pos = skipTemplateIn(text, pos);
      else if (ch === "(" || ch === "[" || ch === "{") {
        const close = findMatchingIn(text, pos);
        pos = close < 0 ? text.length : close + 1;
      } else if (ch === "=") {
        if (text[pos + 1] === ">" || text[pos + 1] === "=") {
          pos += 2;
        } else {
          return pos;
        }
      } else pos++;
    }
    return -1;
  }

  const code = rewrite(0, source.length);
  return { code, macros };
}

function computeLineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

export { MacroSyntaxError };
