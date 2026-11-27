/**
 * ATO-2536: the script an artifact page runs before anything of its own
 * (artifact-rtc-block.ts serves it as `(artifactPageGuard)(tags)` in a
 * `<script>`). It is shipped by its source text, so it must not use anything
 * from outside its own body: no imports, no module-level names.
 *
 * The page runs right after it, in the same realm, and may change any
 * built-in (`RegExp.prototype.exec`, `String.prototype.replace`,
 * `Function.prototype.apply`, the `String` global, an `Object.prototype`
 * setter…). So every check here uses only what it captured before the page
 * ran: `Reflect.apply`, `Object.defineProperty`, `String.prototype.slice`,
 * `DOMException` and the original DOM methods. No RegExp at call time, no
 * method call on a value the page gave. A value the page gave is turned into
 * a string once (`"" + v`), and that one string is both checked and passed
 * on, so a `toString` that answers differently the second time does not
 * help. Objects handed to the browser are literals (own properties), so an
 * `Object.prototype` getter or setter does not either.
 */
export function artifactPageGuard(frameTags: string[]): void {
  const W: any = globalThis;
  const O = Object;
  const define = O.defineProperty;
  const ownDesc = O.getOwnPropertyDescriptor;
  const call = Reflect.apply;
  const slice = String.prototype.slice;
  const DE = W.DOMException;
  const table = (): any => O.create(null);

  const lock = (o: any, k: string, v: unknown): void => {
    try { define(o, k, { value: v, writable: false, configurable: false }); } catch { /* not there */ }
  };
  /** Replace `proto[key]` (when it owns that method) with `make(original)`, locked. */
  const wrap = (proto: any, key: string, make: (orig: any) => unknown): void => {
    const d = proto ? ownDesc(proto, key) : undefined;
    if (d && typeof d.value === "function") lock(proto, key, make(d.value));
  };
  const no = (): never => { throw new DE("Frames are not available in an artifact", "NotSupportedError"); };
  const str = (v: unknown): string => "" + (v as string);
  const cut = (s: string, a: number, b: number): string => call(slice, s, [a, b]);

  const LOWER = table();
  const UP = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const LO = "abcdefghijklmnopqrstuvwxyz";
  for (let i = 0; i < 26; i++) LOWER[UP[i]] = LO[i];
  const lower = (s: string): string => {
    let r = "";
    for (let i = 0; i < s.length; i++) r += LOWER[s[i]] || s[i];
    return r;
  };
  const TAGS = table();
  for (let i = 0; i < frameTags.length; i++) TAGS[frameTags[i]] = 1;
  /** What ends a tag name for the HTML and the XML tokenizer: ASCII whitespace, `/`, `>`. */
  const STOP = table();
  STOP["\t"] = 1; STOP["\n"] = 1; STOP["\f"] = 1; STOP["\r"] = 1; STOP[" "] = 1; STOP["/"] = 1; STOP[">"] = 1;

  const lastColon = (q: string): number => {
    let k = -1;
    for (let i = 0; i < q.length; i++) if (q[i] === ":") k = i;
    return k;
  };
  /** A frame-like name, with or without a namespace prefix (`iframe`, `IFRAME`, `h:iframe`). */
  const isFrame = (q: string): boolean => TAGS[lower(cut(q, lastColon(q) + 1, q.length))] === 1;

  /** Same rule as stripChildFrames (artifact-rtc-block.ts), without a RegExp. */
  const strip = (v: unknown): string => {
    const s = str(v);
    const n = s.length;
    let out = "";
    let from = 0;
    let i = 0;
    while (i < n) {
      if (s[i] !== "<") { i++; continue; }
      let j = i + 1;
      if (j < n && s[j] === "/") j++;
      let k = j;
      while (k < n && STOP[s[k]] !== 1 && s[k] !== "<") k++;
      const name = cut(s, j, k);
      if (name !== "" && (k >= n || STOP[s[k]] === 1) && isFrame(name)) {
        const c = lastColon(name) + 1;
        out += cut(s, from, j) + cut(name, 0, c) + "x-blocked-" + cut(name, c, name.length);
        from = k;
      }
      i = k > i ? k : i + 1;
    }
    return out + cut(s, from, n);
  };
  /** The text ends inside a tag name (`<ifr`, `</h:`, `<`): the next write would finish it. */
  const endsInTagName = (s: string): boolean => {
    let i = s.length - 1;
    while (i >= 0 && s[i] !== "<" && s[i] !== "/" && STOP[s[i]] !== 1) i--;
    if (i < 0) return false;
    if (s[i] === "<") return true;
    return s[i] === "/" && i > 0 && s[i - 1] === "<";
  };
  /** `<!DOCTYPE` anywhere: an XML internal subset could declare an entity whose text becomes markup. */
  const hasDoctype = (s: string): boolean => {
    for (let i = 0; i + 9 <= s.length; i++) {
      if (s[i] === "<" && s[i + 1] === "!" && lower(cut(s, i + 2, i + 9)) === "doctype") return true;
    }
    return false;
  };

  // 1. No RTC constructor in this realm, and no way to put one back.
  const names = O.getOwnPropertyNames(W);
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (cut(n, 0, 3) === "RTC" || cut(n, 0, 9) === "webkitRTC") lock(W, n, undefined);
  }

  // 2. No child frame, so no fresh realm with its own RTC constructors.
  const DP = W.Document && W.Document.prototype;
  wrap(DP, "createElement", (orig) => function (this: unknown, ...a: unknown[]) {
    const n = str(a[0]);
    if (isFrame(n)) no();
    return call(orig, this, a.length > 1 ? [n, a[1]] : [n]);
  });
  wrap(DP, "createElementNS", (orig) => function (this: unknown, ...a: unknown[]) {
    const q = str(a[1]);
    if (isFrame(q)) no();
    return call(orig, this, a.length > 2 ? [a[0], q, a[2]] : [a[0], q]);
  });
  wrap(W.DOMImplementation && W.DOMImplementation.prototype, "createDocument", (orig) => function (this: unknown, ...a: unknown[]) {
    if (a.length < 2) return call(orig, this, a);
    const q = a[1] === null ? "" : str(a[1]);
    if (isFrame(q)) no();
    return call(orig, this, a.length > 2 ? [a[0], q, a[2]] : [a[0], q]);
  });
  wrap(W.CustomElementRegistry && W.CustomElementRegistry.prototype, "define", (orig) => function (this: unknown, ...a: unknown[]) {
    if (a.length < 3 || a[2] === undefined || a[2] === null) return call(orig, this, [a[0], a[1]]);
    const ext = (a[2] as { extends?: unknown }).extends;
    if (ext === undefined) return call(orig, this, [a[0], a[1], {}]);
    const e = str(ext);
    if (isFrame(e)) no();
    return call(orig, this, [a[0], a[1], { extends: e }]);
  });
  lock(W, "XSLTProcessor", undefined);

  // document.write: one string, stripped; a write that stops inside a tag name is refused,
  // since the parser would join it with the next write (`<ifr` + `ame>`).
  const writer = (orig: any) => function (this: unknown, ...a: unknown[]) {
    let s = "";
    for (let i = 0; i < a.length; i++) s += str(a[i]);
    if (endsInTagName(s)) no();
    return call(orig, this, [strip(s)]);
  };
  for (const proto of [DP, W.HTMLDocument && W.HTMLDocument.prototype]) {
    wrap(proto, "write", writer);
    wrap(proto, "writeln", writer);
  }
  wrap(DP, "execCommand", (orig) => function (this: unknown, ...a: unknown[]) {
    const c = str(a[0]);
    return call(orig, this, [c, a[1], lower(c) === "inserthtml" && a[2] !== undefined ? strip(a[2]) : a[2]]);
  });
  wrap(W.DOMParser && W.DOMParser.prototype, "parseFromString", (orig) => function (this: unknown, ...a: unknown[]) {
    const s = str(a[0]);
    const t = str(a[1]);
    if (t !== "text/html" && hasDoctype(s)) no();
    return call(orig, this, [strip(s), t]);
  });

  // 3. Every HTML string through the default Trusted Types policy (the page CSP turns enforcement on).
  const tt = W.trustedTypes;
  if (tt) {
    const TP = O.getPrototypeOf(tt);
    const make = TP.createPolicy;
    lock(TP, "createPolicy", function (this: unknown, ...a: unknown[]) {
      const rules = a[1] as { createHTML?: unknown; createScript?: unknown; createScriptURL?: unknown } | null | undefined;
      let h: unknown = undefined, sc: unknown = undefined, su: unknown = undefined;
      if (rules !== undefined && rules !== null) {
        h = rules.createHTML;
        sc = rules.createScript;
        su = rules.createScriptURL;
      }
      const html = typeof h === "function"
        ? function (this: unknown, ...b: unknown[]) { const v = call(h as any, this, b); return v === undefined || v === null ? v : strip(v); }
        : undefined;
      return call(make, this, [a[0], { createHTML: html, createScript: sc, createScriptURL: su }]);
    });
    call(make, tt, ["default", { createHTML: strip, createScript: (s: string) => s, createScriptURL: (s: string) => s }]);
    if (W.TrustedHTML) lock(W.TrustedHTML, "fromLiteral", undefined);
  }
}
