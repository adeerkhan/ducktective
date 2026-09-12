/** The same inclusive-end fault as the Python fixture, for the node:test parser. */
export function total(rows, start = 0, end = null) {
  const stop = end === null ? rows.length - 1 : end;
  return rows.slice(start, stop).reduce((a, b) => a + b, 0);
}
