export function clamp(n, min, max) {
  if (typeof n !== "number") return 0;
  if (min > max) {
    const tmp = min;
    min = max;
    max = tmp;
  }
  return Math.min(Math.max(n, min), max);
}

export function round(n, decimals = 0) {
  if (typeof n !== "number") return 0;
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

export function inRange(n, min, max) {
  if (typeof n !== "number") return false;
  return n >= min && n < max;
}
