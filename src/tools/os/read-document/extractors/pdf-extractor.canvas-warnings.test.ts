import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

/**
 * Regression test for issue #117.
 *
 * pdfjs-dist warns at *import time* when its optional `@napi-rs/canvas`
 * dependency is missing. Those warnings look like extraction failures even
 * though text-only extraction is unaffected. They cannot be reproduced inside
 * the vitest process: pdfjs is very likely already imported (module cache), and
 * a normal dev install has `@napi-rs/canvas` present, which hides the symptom
 * entirely.
 *
 * So this test builds a throwaway package tree that resolves `pdfjs-dist` but
 * *not* `@napi-rs/canvas` — the shape produced by `npm ci --omit=optional` and
 * by our SEA bundle — and runs the extractor in a fresh child process.
 */

const KNOWN_CANVAS_WARNINGS = [
  'Cannot load "@napi-rs/canvas" package',
  "Cannot polyfill `DOMMatrix`",
  "Cannot polyfill `ImageData`",
  "Cannot polyfill `Path2D`",
];

const TEXT_MARKER = "ATOMIC_PDF_MARKER";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../..");

/** A tiny single-page PDF with uncompressed, extractable text. */
function buildPdf(): string {
  const content = `BT /F1 24 Tf 72 700 Td (${TEXT_MARKER}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R " +
      "/Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xref}\n%%EOF\n`;
  return pdf;
}

/**
 * Build a sandbox whose `node_modules` contains only `pdfjs-dist`, with
 * `@napi-rs/canvas` deliberately absent — the shape of `npm ci --omit=optional`
 * and of our SEA bundle.
 *
 * pdfjs must be *copied*, not symlinked. It resolves the optional canvas
 * package via `createRequire(import.meta.url)`, and `import.meta.url` points at
 * the module's real path — Node resolves symlinks by default. A symlinked
 * pdfjs would therefore walk up the *real* `node_modules` and find the canvas
 * package that a dev machine has installed, silently defeating the isolation.
 */
async function makeCanvasFreeSandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atomic-pdf-nocanvas-"));
  const nodeModules = join(dir, "node_modules");
  const require = createRequire(import.meta.url);
  const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));

  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "sandbox", private: true, type: "module" }),
  );
  await mkdir(nodeModules, { recursive: true });
  // Skip pdfjs's own nested deps and the browser-only `web/` viewer. The
  // filter receives absolute *source* paths, so compare against the portion
  // below `pdfjsRoot` — matching on the absolute path would reject the copy
  // root itself (it already sits inside a `node_modules` directory).
  await cp(pdfjsRoot, join(nodeModules, "pdfjs-dist"), {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const rel = src.slice(pdfjsRoot.length);
      return !rel.startsWith(`${sep}node_modules`) && !rel.startsWith(`${sep}web`);
    },
  });
  return dir;
}

/**
 * The extractor's loading strategy, mirrored as standalone source so it can run
 * in the sandbox without pulling in the whole TypeScript build. `applyFix`
 * toggles the fix, which lets the same harness prove the test actually detects
 * the bug (ablation) rather than passing vacuously.
 */
function sandboxScript(pdfPath: string, applyFix: boolean): string {
  return `
import Module from "node:module";
import fs from "node:fs";

const CANVAS_PACKAGE = "@napi-rs/canvas";
const CANVAS_STUB = {
  DOMMatrix: class {}, ImageData: class {}, Path2D: class {},
};

async function load() {
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

let pdfjs;
if (${applyFix ? "true" : "false"}) {
  const original = Module._load;
  Module._load = function (...args) {
    if (args[0] === CANVAS_PACKAGE) return CANVAS_STUB;
    return original.apply(this, args);
  };
  try { pdfjs = await load(); } finally { Module._load = original; }
} else {
  pdfjs = await load();
}

globalThis.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");

const doc = await pdfjs.getDocument({
  data: new Uint8Array(fs.readFileSync(${JSON.stringify(pdfPath)})),
  disableFontFace: true,
  useSystemFonts: false,
  isEvalSupported: false,
  verbosity: 0,
}).promise;

let text = "";
for (let p = 1; p <= doc.numPages; p++) {
  const c = await (await doc.getPage(p)).getTextContent();
  text += c.items.map((i) => i.str).join("");
}
await doc.destroy();
process.stdout.write("EXTRACTED:" + text + "\\n");
`;
}

async function runInSandbox(
  applyFix: boolean,
): Promise<{ stdout: string; stderr: string }> {
  const dir = await makeCanvasFreeSandbox();
  try {
    const pdfPath = join(dir, "sample.pdf");
    await writeFile(pdfPath, buildPdf(), "latin1");
    const scriptPath = join(dir, "run.mjs");
    await writeFile(scriptPath, sandboxScript(pdfPath, applyFix));
    return await execFileAsync(process.execPath, [scriptPath], {
      cwd: dir,
      encoding: "utf8",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("pdf extractor: optional canvas warnings (issue #117)", () => {
  it("sanity-checks that the sandbox really lacks @napi-rs/canvas", async () => {
    const dir = await makeCanvasFreeSandbox();
    try {
      // Probe from inside the copied pdfjs build — that is where pdfjs itself
      // resolves the optional package from. Probing at the sandbox root would
      // pass even if a symlinked pdfjs could still reach the real install.
      const probe = join(
        dir,
        "node_modules",
        "pdfjs-dist",
        "legacy",
        "build",
        "probe.mjs",
      );
      await writeFile(
        probe,
        'import { createRequire } from "node:module";\n' +
          "try {\n" +
          '  createRequire(import.meta.url).resolve("@napi-rs/canvas");\n' +
          '  process.stdout.write("RESOLVED");\n' +
          '} catch { process.stdout.write("ABSENT"); }\n',
      );
      const { stdout } = await execFileAsync(process.execPath, [probe], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(stdout).toBe("ABSENT");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("emits the canvas warnings without the fix (ablation)", async () => {
    const { stdout, stderr } = await runInSandbox(false);
    // Guard against a vacuous pass: the ablation must still extract text.
    expect(stdout).toContain(`EXTRACTED:${TEXT_MARKER}`);
    const combined = stdout + stderr;
    for (const warning of KNOWN_CANVAS_WARNINGS) {
      expect(combined).toContain(warning);
    }
  }, 60_000);

  it("emits no canvas warnings with the fix, and still extracts text", async () => {
    const { stdout, stderr } = await runInSandbox(true);
    expect(stdout).toContain(`EXTRACTED:${TEXT_MARKER}`);
    const combined = stdout + stderr;
    for (const warning of KNOWN_CANVAS_WARNINGS) {
      expect(combined).not.toContain(warning);
    }
  }, 60_000);

  it("does not intercept console anywhere in the extractor", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(join(here, "pdf-extractor.ts"), "utf8");
    expect(source).not.toMatch(/console\s*\.\s*(log|warn|error)\s*=/);
  });

  it("leaves Module._load restored after loading pdfjs", async () => {
    const Module = (await import("node:module")).default as unknown as {
      _load: unknown;
    };
    const before = Module._load;
    const { pdfExtractor } = await import("./pdf-extractor.js");
    const data = Buffer.from(buildPdf(), "latin1");
    const result = await pdfExtractor({
      data,
      path: join(repoRoot, "sample.pdf"),
    } as Parameters<typeof pdfExtractor>[0]);
    expect(result.text).toContain(TEXT_MARKER);
    expect(Module._load).toBe(before);
  }, 60_000);

  it("the real extractor stays quiet in this install (gates the CI matrix)", async () => {
    // The sandbox tests above build their own canvas-free node_modules, so
    // they answer the same way whether or not the outer install has
    // `@napi-rs/canvas` — which left the "no canvas" CI job unable to fail
    // for the reason it exists. This one runs the *real* extractor against
    // the *real* install: it passes when canvas is present (the quiet path is
    // skipped) and fails when canvas is absent and the fix is broken. That
    // difference is the signal the matrix is built to carry.
    //
    // It must run in a fresh process. pdfjs emits these warnings once, at
    // import time, via `console.log` — by the time an in-process test could
    // install a spy, an earlier test in the same file has already imported
    // the module and the warnings are long gone.
    const pdfPath = join(tmpdir(), `canvas-gate-${process.pid}.pdf`);
    const scriptPath = join(tmpdir(), `canvas-gate-${process.pid}.mjs`);
    await writeFile(pdfPath, buildPdf(), "latin1");
    await writeFile(
      scriptPath,
      [
        'import { readFile } from "node:fs/promises";',
        `const { pdfExtractor } = await import(${JSON.stringify(
          pathToFileURL(join(here, "pdf-extractor.ts")).href,
        )});`,
        `const data = await readFile(${JSON.stringify(pdfPath)});`,
        `const result = await pdfExtractor({ data, path: ${JSON.stringify(
          pdfPath,
        )} });`,
        // Generous slice: the text opens with a `--- page 1 ---` header, and a
        // tighter bound would cut the marker off if that header ever grows.
        'process.stdout.write("\\nEXTRACTED:" + result.text.slice(0, 200));',
      ].join("\n"),
    );

    try {
      // The warnings are emitted at import time, before extraction, so they
      // are in the buffer even when the child later fails. `execFileAsync`
      // rejects on a non-zero exit, which would skip the assertions entirely
      // and report "Command failed: … canvas-gate.mjs" instead of naming the
      // regression — so read the output off the rejection too.
      let output: string;
      try {
        const { stdout, stderr } = await execFileAsync(
          process.execPath,
          ["--import", "tsx", scriptPath],
          { cwd: repoRoot, encoding: "utf8" },
        );
        output = `${stdout}\n${stderr}`;
      } catch (err) {
        const failed = err as { stdout?: string; stderr?: string };
        output = `${failed.stdout ?? ""}\n${failed.stderr ?? ""}`;
        for (const warning of KNOWN_CANVAS_WARNINGS) {
          expect(output).not.toContain(warning);
        }
        throw err;
      }

      // Guard against a vacuous pass: `EXTRACTED:` alone prints even when the
      // extractor returns empty text, so assert the marker came through. The
      // extracted text opens with a `--- page 1 ---` header, so the marker
      // follows the prefix rather than sitting flush against it.
      expect(output).toContain("EXTRACTED:");
      expect(output).toContain(TEXT_MARKER);
      for (const warning of KNOWN_CANVAS_WARNINGS) {
        expect(output).not.toContain(warning);
      }
    } finally {
      await rm(pdfPath, { force: true });
      await rm(scriptPath, { force: true });
    }
  }, 60_000);
});
