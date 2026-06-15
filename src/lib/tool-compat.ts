type SemVer = [number, number, number];

function parseSemVer(v: string): SemVer | null {
  const m = v.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function cmpSemVer(a: SemVer, b: SemVer): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Compare an installed tool version against the compat manifest entry.
 * Returns a warning string when the version is below min or above lastVerified,
 * or null when the version is in-range or unparseable (non-blocking).
 * `min` is optional — entries without a floor are only drift-checked against lastVerified.
 */
export function checkToolCompat(
  name: string,
  rawVersion: string,
  entry: { min?: string; lastVerified?: string },
): string | null {
  const installed = parseSemVer(rawVersion);
  if (!installed) return null;

  const min = entry.min ? parseSemVer(entry.min) : null;
  if (min && cmpSemVer(installed, min) < 0) {
    return `${name} ${rawVersion} < min ${entry.min} — upgrade to ${entry.min}+`;
  }

  if (entry.lastVerified) {
    const lastVerified = parseSemVer(entry.lastVerified);
    if (lastVerified && cmpSemVer(installed, lastVerified) > 0) {
      return `${name} ${rawVersion} > last-verified ${entry.lastVerified} — re-run compat audit`;
    }
  }

  return null;
}
