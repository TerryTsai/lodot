/** Selects a key for a value at a given iteration index. */
export type KeySelector<T, K> = (value: T, index: number) => K;

/**
 * Groups values by a derived key while preserving input order.
 *
 * A Map is returned so keys can be values of any type without string coercion.
 */
export function groupBy<T, K>(
  values: Iterable<T>,
  keyOf: KeySelector<T, K>,
): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  let index = 0;

  for (const value of values) {
    const key = keyOf(value, index);
    const group = groups.get(key);

    if (group === undefined) {
      groups.set(key, [value]);
    } else {
      group.push(value);
    }

    index += 1;
  }

  return groups;
}

/**
 * Returns the first value for each derived key while preserving input order.
 */
export function uniqueBy<T, K>(
  values: Iterable<T>,
  keyOf: KeySelector<T, K>,
): T[] {
  const seen = new Set<K>();
  const unique: T[] = [];
  let index = 0;

  for (const value of values) {
    const key = keyOf(value, index);

    if (!seen.has(key)) {
      seen.add(key);
      unique.push(value);
    }

    index += 1;
  }

  return unique;
}
