export function total(rows) {
  return rows.slice(0, rows.length - 1).reduce((a, b) => a + b, 0);
}
