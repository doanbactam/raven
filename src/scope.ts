export interface ScopeCheckResult {
  passed: boolean;
  changedFiles: string[];
  outOfScopeFiles: string[];
}

export function checkOwnedFileScope(
  changedFiles: readonly string[],
  ownedFiles: readonly string[],
): ScopeCheckResult {
  const normalizedOwned = ownedFiles.map(normalizePath).filter(Boolean);
  const normalizedChanged = changedFiles.map(normalizePath).filter(Boolean);
  const outOfScopeFiles = normalizedChanged.filter(
    (file) => !normalizedOwned.some((owned) => matchesOwnedPath(file, owned)),
  );
  return {
    passed: outOfScopeFiles.length === 0,
    changedFiles: normalizedChanged,
    outOfScopeFiles,
  };
}

function matchesOwnedPath(file: string, owned: string): boolean {
  if (owned === file) return true;
  if (owned.endsWith("/")) return file.startsWith(owned);
  if (file.startsWith(`${owned}/`)) return true;
  if (owned.includes("*")) return globToRegExp(owned).test(file);
  return false;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/").trim();
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

export const _internals = { matchesOwnedPath, normalizePath, globToRegExp };
