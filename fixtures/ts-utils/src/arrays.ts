export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [];
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

export function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

export function zip<A, B>(a: A[], b: B[]): [A, B][] {
  const len = Math.min(a.length, b.length);
  const result: [A, B][] = [];
  for (let i = 0; i < len; i++) result.push([a[i]!, b[i]!]);
  return result;
}

export function flatten<T>(arr: T[][]): T[] {
  return arr.reduce<T[]>((acc, cur) => acc.concat(cur), []);
}
