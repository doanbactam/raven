export function chunk(arr, size) {
  if (!Array.isArray(arr) || size <= 0) return [];
  const result = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

export function unique(arr) {
  if (!Array.isArray(arr)) return [];
  return Array.from(new Set(arr));
}

export function groupBy(arr, keyFn) {
  if (!Array.isArray(arr) || typeof keyFn !== "function") return {};
  const result = {};
  for (const item of arr) {
    const key = keyFn(item);
    if (!result[key]) result[key] = [];
    result[key].push(item);
  }
  return result;
}
