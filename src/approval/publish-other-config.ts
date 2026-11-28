/**
 * Publish flags that point a package publish at config the egress scan
 * does not read (review round 3 of ATO-2528), for `scanPublish` in
 * `egress-scan-tools.ts`. Pure.
 */
const JS_PUBLISHERS = new Set(["npm", "pnpm", "yarn"]);
/** Flags that make npm, pnpm or yarn read another folder's or file's config. */
const JS_OTHER_CONFIG = new Set(["--userconfig", "--globalconfig", "--prefix", "-C", "--dir", "--cwd"]);

/** Long npm options a flag may abbreviate: npm expands `--reg=x` to `--registry=x` (review round 3). */
const NPM_ABBREVIABLE = ["registry", "userconfig", "globalconfig", "prefix"];

/**
 * Whether a flag points the publish at config this does not read
 * (review round 3 of ATO-2528), anywhere on the line: another npmrc
 * (`--userconfig`), another folder whose `.npmrc` and `package.json`
 * apply (`npm --prefix sub publish`, `pnpm -C`, `yarn --cwd`), an abbreviated option npm expands
 * (`--reg=`), a cargo `--config` or another manifest, a twine or gem
 * config file. The registry is then unknown unless a registry flag names it.
 */
export function readsOtherConfig(program: string, args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--") break;
    const name = arg.split("=")[0]!;
    if (JS_PUBLISHERS.has(program)) {
      if (JS_OTHER_CONFIG.has(name)) return true;
      const word = name.slice(2);
      if (/^--[a-z]{2,}$/.test(name) && NPM_ABBREVIABLE.some((full) => full !== word && full.startsWith(word))) return true;
    }
    if (program === "cargo" && ["--config", "-C", "--manifest-path"].includes(name)) return true;
    if ((program === "twine" || program === "gem") && name === "--config-file") return true;
  }
  return false;
}

/** `--@acme:registry=x`: the registry of a scope, which wins over `--registry` for its packages. */
export function setsScopedRegistry(program: string, args: readonly string[]): boolean {
  if (!JS_PUBLISHERS.has(program)) return false;
  const end = args.indexOf("--");
  return (end === -1 ? args : args.slice(0, end)).some((arg) => arg.startsWith("--@"));
}
