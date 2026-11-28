// ATO-2749: the OS pane app:openMicSettings opens (main/mic-settings.ts), against the built output.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { micSettingsUrl } = require("../out/main/mic-settings.js");

test("macOS and Windows open their microphone pane; Linux has none", () => {
  assert.equal(micSettingsUrl("darwin"), "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
  assert.equal(micSettingsUrl("win32"), "ms-settings:privacy-microphone");
  assert.equal(micSettingsUrl("linux"), null);
});

test("main's app:openMicSettings goes through it", () => {
  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  assert.match(main, /import \{ micSettingsUrl \} from "\.\/mic-settings\.js";/);
  assert.match(main, /const url = micSettingsUrl\(process\.platform\);/);
  assert.doesNotMatch(main, /"app:openMicSettings", \(\) => \{\n\s+if \(process\.platform !== "darwin"\)/);
});
