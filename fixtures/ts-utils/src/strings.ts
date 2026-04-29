export function capitalize(input: string): string {
  if (input.length === 0) return input;
  return input[0]!.toUpperCase() + input.slice(1);
}

export function camelCase(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, ch: string) => ch.toUpperCase())
    .replace(/^[A-Z]/, (ch) => ch.toLowerCase());
}

export function truncate(input: string, maxLen: number, suffix = "..."): string {
  if (maxLen <= 0) return "";
  if (input.length <= maxLen) return input;
  const end = Math.max(0, maxLen - suffix.length);
  return input.slice(0, end) + suffix;
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
