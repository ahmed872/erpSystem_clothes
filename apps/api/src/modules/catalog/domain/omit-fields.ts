/** Shallow-clones `obj` with `keys` removed. Used to strip cost fields from
 * catalog responses for callers without products.view_cost. */
export function omitFields<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Omit<T, K> {
  const clone = { ...obj } as T;
  for (const key of keys) {
    delete clone[key];
  }
  return clone;
}
