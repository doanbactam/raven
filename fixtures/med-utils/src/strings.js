export function slugify(input) {
  if (typeof input !== "string") return "";
  return input
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function truncate(input, max, suffix = "...") {
  if (typeof input !== "string") return "";
  if (max <= 0) return "...";
  if (input.length <= max) return input;
  const end = Math.max(0, max - suffix.length);
  return input.slice(0, end) + suffix;
}

export function capitalize(input) {
  if (typeof input !== "string" || input.length === 0) return "";
  return input.charAt(0).toUpperCase() + input.slice(1);
}
