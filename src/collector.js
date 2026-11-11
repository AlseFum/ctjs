/**
 * A tiny synchronous collector used by examples and tests.
 *
 * In the language model a collector is a *compile-time API*: modules call
 * `register` while their compile-time top level is evaluated, and `<await>
 * collector.collectAll()` freezes the registered values into a compile-time
 * value.  It is deliberately synchronous; the Babel transform cannot suspend
 * on a Promise.
 */
export function createCollector() {
  const values = [];
  return {
    register(value) {
      values.push(value);
      return value;
    },
    collectAll() {
      return values.slice();
    },
    get size() {
      return values.length;
    },
  };
}
