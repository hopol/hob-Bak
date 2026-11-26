export function isSemver(value: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value);
}

/** Compare dotted versions and semver prereleases without depending on a package manager. */
export function newerPluginVersion(candidate: string, installed: string): boolean {
  const parse = (value: string) => /^(?:v)?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  const a = parse(candidate), b = parse(installed);
  if (!a || !b) return false;
  const left = a[1].split(".").map(Number), right = b[1].split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return difference > 0;
  }
  if (!a[2] || !b[2]) return !a[2] && !!b[2];
  const ap = a[2].split("."), bp = b[2].split(".");
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === undefined) return false;
    if (bp[i] === undefined) return true;
    if (ap[i] === bp[i]) continue;
    const an = /^\d+$/.test(ap[i]), bn = /^\d+$/.test(bp[i]);
    if (an && bn) return Number(ap[i]) > Number(bp[i]);
    if (an !== bn) return bn;
    return ap[i] > bp[i];
  }
  return false;
}
