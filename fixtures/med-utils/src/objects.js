export function pick(obj, keys) {
  if (typeof obj !== "object" || obj === null) return {};
  if (!Array.isArray(keys)) return {};
  const result = {};
  for (const key of keys) {
    if (key in obj) {
      result[key] = obj[key];
    }
  }
  return result;
}

export function omit(obj, keys) {
  if (typeof obj !== "object" || obj === null) return {};
  if (!Array.isArray(keys)) return { ...obj };
  const keySet = new Set(keys);
  const result = {};
  for (const key of Object.keys(obj)) {
    if (!keySet.has(key)) {
      result[key] = obj[key];
    }
  }
  return result;
}

export function isEmpty(obj) {
  if (obj === null || obj === undefined) return true;
  if (typeof obj !== "object") return false;
  if (Array.isArray(obj)) return obj.length === 0;
  return Object.keys(obj).length === 0;
}
