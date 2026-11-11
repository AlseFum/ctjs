import vm from "node:vm";
import { transform } from "../src/index.js";

export function compile(source, options = {}) {
  return transform(source, options).code;
}

export function run(source, context = {}, options = {}) {
  const code = compile(source, options);
  const logs = [];
  const sandbox = {
    console: {
      log: (...args) => logs.push(args.map(String).join(" ")),
      error: (...args) => logs.push(args.map(String).join(" ")),
    },
    ...context,
  };
  vm.runInNewContext(code, sandbox, { timeout: 2000 });
  return { code, logs, sandbox };
}

export function runCode(code, context = {}) {
  const logs = [];
  const sandbox = {
    console: {
      log: (...args) => logs.push(args.map(String).join(" ")),
    },
    ...context,
  };
  vm.runInNewContext(code, sandbox, { timeout: 2000 });
  return { logs, sandbox };
}
