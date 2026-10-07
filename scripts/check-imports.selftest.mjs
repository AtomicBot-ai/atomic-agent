/** Negative and positive dependency checks in disposable projects. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { check } from './check-imports.mjs';

let passed = 0;
function fixture(name, files, verify, edges = []) {
  const root = mkdtempSync(join(tmpdir(), 'atomic-imports-'));
  const put = (path, content) => { const full = join(root, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, content); };
  try {
    put('tsconfig.json', JSON.stringify({ compilerOptions: { module: 'ES2022', moduleResolution: 'Bundler', jsx: 'react-jsx', resolveJsonModule: true }, include: ['src/**/*.ts', 'src/**/*.tsx'], exclude: ['**/*.test.ts', '**/*.test.tsx'] }));
    put('docs/architecture/import-exceptions.json', JSON.stringify({ schemaVersion: 1, edges }));
    for (const [path, content] of Object.entries(files)) put(path, content);
    verify(() => check(root));
    console.log(`ok: ${name}`); passed++;
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const clean = (run) => assert.deepEqual(run().errors, []);
const rejects = (pattern) => (run) => assert.match(run().errors.join('\n'), pattern);
const pair = {
  'src/a.ts': 'export const value = 1; export type A = string;',
  'src/b.tsx': 'export const value = 2; export type B = string;',
};
fixture('ESM .js resolves to TS and TSX', { ...pair, 'src/c.ts': 'import { value } from "./b.js"; export { value as other } from "./a.js";' }, (run) => { const r = run(); assert.equal(r.edges.length, 2); assert.deepEqual(r.errors, []); });
fixture('new runtime cycle', { ...pair, 'src/a.ts': 'import "./b.js";', 'src/b.tsx': 'import "./a.js";' }, rejects(/runtime import cycle/));
fixture('self import cycle', { 'src/a.ts': 'import "./a.js";' }, rejects(/runtime import cycle/));
fixture('dynamic literal cycle', { 'src/a.ts': 'void import("./b.js");', 'src/b.ts': 'export * from "./a.js";' }, rejects(/runtime import cycle/));
fixture('missing local target', { 'src/a.ts': 'import "./lost.js";' }, rejects(/unresolved local import/));
fixture('missing type-only target', { 'src/a.ts': 'type A = import("./lost.js").A;' }, rejects(/unresolved local import/));
fixture('domain cannot depend on UI types', { 'src/config/a.ts': 'import type { A } from "../tui/a.js";', 'src/tui/a.ts': 'export type A = string;' }, rejects(/domain depends on an interface.*type-only/));
fixture('channel cannot depend on TUI', { 'src/channels/a.ts': 'import "../tui/a.js";', 'src/tui/a.ts': '' }, rejects(/channel depends on TUI/));
fixture('HTTP cannot depend on TUI', { 'src/http/a.ts': 'import "../tui/a.js";', 'src/tui/a.ts': '' }, rejects(/HTTP interface depends on TUI/));
fixture('domain cannot depend on channels', { 'src/llm/provider/a.ts': 'import "../../channels/a.js";', 'src/channels/a.ts': '' }, rejects(/domain depends on an interface/));
fixture('type-only cycle allowed', { 'src/a.ts': 'import { type B } from "./b.js"; export type A = string;', 'src/b.ts': 'export type { A } from "./a.js"; export type B = string;' }, clean);
fixture('mixed type/value imports remain runtime', { 'src/a.ts': 'import { type B, value } from "./b.js"; export type A = string;', 'src/b.ts': 'import "./a.js"; export type B = string; export const value = 1;' }, rejects(/runtime import cycle/));
fixture('mixed type/value exports remain runtime', { 'src/a.ts': 'export { type B, value } from "./b.js";', 'src/b.ts': 'import "./a.js"; export type B = string; export const value = 1;' }, rejects(/runtime import cycle/));
fixture('composition root allowed', { 'src/cli/index.ts': 'import "../tui/index.js";', 'src/tui/index.ts': '' }, clean);
fixture('composition root exception is exact', { 'src/cli/a.ts': 'import "../tui/index.js";', 'src/tui/index.ts': '' }, rejects(/CLI bypasses/));
fixture('shared list cannot depend on wizard', { 'src/tui/components/pick-list.tsx': 'import type { A } from "../providers/a.js";', 'src/tui/providers/a.ts': 'export type A = string;' }, rejects(/shared UI primitive depends on a feature/));
fixture('shared input cannot depend on domain', { 'src/tui/input/a.ts': 'import "../../config/a.js";', 'src/config/a.ts': '' }, rejects(/shared UI primitive depends on a domain/));
fixture('composer shared contract cannot depend on builders', { 'src/tui/composer-switch/composer-switch-row-contracts.ts': 'import "./composer-switch-worker-rows.js";', 'src/tui/composer-switch/composer-switch-worker-rows.ts': '' }, rejects(/shared composer contract/));
fixture('test cycles do not enter production graph', { ...pair, 'src/x.test.ts': 'import "./y.test.js";', 'src/y.test.ts': 'import "./x.test.js";' }, clean);
fixture('production cannot import excluded tests', { 'src/a.ts': 'import "./a.test.js";', 'src/a.test.ts': '' }, rejects(/outside checked graph/));
fixture('JSON resolves, external packages do not enter graph', { 'src/a.ts': 'import x from "./data.json"; import y from "some-package";', 'src/data.json': '{}' }, (run) => { const r = run(); assert.deepEqual(r.errors, []); assert.equal(r.edges.length, 1); });
const exception = { source: 'src/config/a.ts', target: 'src/tui/a.ts', owner: 'fixture', reason: 'reviewed fixture edge' };
fixture('reviewed exact exception', { 'src/config/a.ts': 'import "../tui/a.js";', 'src/tui/a.ts': '' }, clean, [exception]);
fixture('stale exception rejected', { 'src/config/a.ts': '', 'src/tui/a.ts': '' }, rejects(/stale import exception/), [exception]);
fixture('wildcard exception rejected', { 'src/config/a.ts': '' }, (run) => assert.throws(run, /exact source\/target/), [{ ...exception, source: 'src/config/*' }]);
fixture('unowned exception rejected', { 'src/config/a.ts': '' }, (run) => assert.throws(run, /owner and reason/), [{ ...exception, owner: '' }]);
fixture('shared logo rejects chat types', { 'src/tui/components/logo.tsx': 'import type { A } from "../chat/a.js";', 'src/tui/chat/a.ts': 'export type A = string;' }, rejects(/shared UI primitive depends on a feature.*type-only/));
fixture('shared editor rejects context handler', { 'src/tui/components/multi-line-editor.tsx': 'import "../context/a.js";', 'src/tui/context/a.ts': '' }, rejects(/shared UI primitive depends on a feature/));
fixture('shared theme rejects chooser', { 'src/tui/theme/theme.ts': 'import "../theme-picker/a.js";', 'src/tui/theme-picker/a.ts': '' }, rejects(/shared UI primitive depends on a feature/));
fixture('shared formatting rejects domain', { 'src/tui/components/format-tokens.ts': 'import "../../config/a.js";', 'src/config/a.ts': '' }, rejects(/shared UI primitive depends on a domain/));
fixture('shared logo owns its types', { 'src/tui/components/logo.tsx': 'import type { A } from "./logo-types.js";', 'src/tui/components/logo-types.ts': 'export type A = string;' }, clean);
fixture('shared editor can use row viewport', { 'src/tui/components/multi-line-editor-body.tsx': 'import "../row-window.js";', 'src/tui/row-window.ts': '' }, clean);
fixture('shell composition can use chat and updates', { 'src/tui/components/status-bar.tsx': 'import "../chat/a.js"; import "../update/a.js";', 'src/tui/chat/a.ts': '', 'src/tui/update/a.ts': '' }, clean);
fixture('production cannot import filesystem test helper', { 'src/tools/os/fs/fs-read.ts': 'import "./fs-locate-project-test-helpers.js";', 'src/tools/os/fs/fs-locate-project-test-helpers.ts': '' }, rejects(/production depends on a test helper/));
fixture('filesystem tests may use their helper', { 'src/tools/os/fs/fs-read.test.ts': 'import "./fs-locate-project-test-helpers.js";', 'src/tools/os/fs/fs-locate-project-test-helpers.ts': '' }, clean);
fixture('production cannot import GGUF byte fixtures', { 'src/local-llm/catalog/gguf-metadata.ts': 'import "./gguf-metadata.fixtures.js";', 'src/local-llm/catalog/gguf-metadata.fixtures.ts': '' }, rejects(/production depends on a test helper/));
fixture('GGUF tests may use byte fixtures', { 'src/local-llm/catalog/gguf-metadata.test.ts': 'import "./gguf-metadata.fixtures.js";', 'src/local-llm/catalog/gguf-metadata.fixtures.ts': '' }, clean);
fixture('config primitives cannot import composing schema', { 'src/config/config-primitives.ts': 'import "./config-schema.js";', 'src/config/config-schema.ts': '' }, rejects(/config primitive depends on composition/));
fixture('config primitives cannot import root API types', { 'src/config/config-primitives.ts': 'import type { A } from "./index.js";', 'src/config/index.ts': 'export type A = string;' }, rejects(/config primitive depends on composition.*type-only/));
fixture('config primitives cannot dynamically import composing schema', { 'src/config/config-primitives.ts': 'void import("./config-schema.js");', 'src/config/config-schema.ts': '' }, rejects(/config primitive depends on composition/));
fixture('config primitives use the existing error owner', { 'src/config/config-primitives.ts': 'import "./config-validation-error.js";', 'src/config/config-validation-error.ts': '' }, clean);
fixture('config composition can expose primitives', { 'src/config/config-schema.ts': 'export { value } from "./config-primitives.js";', 'src/config/config-primitives.ts': 'export const value = 1;' }, clean);
fixture('session rail config cannot import composing schema', { 'src/config/session-rail-config.ts': 'import "./config-schema.js";', 'src/config/config-schema.ts': '' }, rejects(/session rail config depends on composition/));
fixture('session rail config cannot import root API types', { 'src/config/session-rail-config.ts': 'import type { A } from "./index.js";', 'src/config/index.ts': 'export type A = string;' }, rejects(/session rail config depends on composition.*type-only/));
fixture('session rail config cannot dynamically import composing schema', { 'src/config/session-rail-config.ts': 'void import("./config-schema.js");', 'src/config/config-schema.ts': '' }, rejects(/session rail config depends on composition/));
fixture('schema and error owner serve session rail config', { 'src/config/config-schema.ts': 'export { value } from "./session-rail-config.js";', 'src/config/session-rail-config.ts': 'import "./config-validation-error.js"; export const value = 1;', 'src/config/config-validation-error.ts': '' }, clean);
fixture('hash contract cannot import prompt schema', { 'src/tools/os/fs/fs-hash-contract.ts': 'import "../../../prompt/default-tool-args-schemas.js";', 'src/prompt/default-tool-args-schemas.ts': '' }, rejects(/hash contract depends on another source owner/));
fixture('hash contract cannot import agent taxonomy types', { 'src/tools/os/fs/fs-hash-contract.ts': 'import type { A } from "../../../agent/tool-resource-class.js";', 'src/agent/tool-resource-class.ts': 'export type A = string;' }, rejects(/hash contract depends on another source owner.*type-only/));
fixture('hash contract cannot dynamically import execution', { 'src/tools/os/fs/fs-hash-contract.ts': 'void import("./fs-hash.js");', 'src/tools/os/fs/fs-hash.ts': '' }, rejects(/hash contract depends on another source owner/));
fixture('hash composition depends inward on its contract', { 'src/prompt/default-tool-args-schemas.ts': 'import "../tools/os/fs/fs-hash-contract.js";', 'src/tools/os/fs/fs-hash.ts': 'import "./fs-hash-contract.js";', 'src/tools/os/fs/fs-hash-contract.ts': '' }, clean);
fixture('webhook config cannot import composing schema', { 'src/config/webhook-config.ts': 'import "./config-schema.js";', 'src/config/config-schema.ts': '' }, rejects(/webhook config depends on composition/));
fixture('webhook config cannot import root API types', { 'src/config/webhook-config.ts': 'import type { A } from "./index.js";', 'src/config/index.ts': 'export type A = string;' }, rejects(/webhook config depends on composition.*type-only/));
fixture('webhook config cannot dynamically import composing schema', { 'src/config/webhook-config.ts': 'void import("./config-schema.js");', 'src/config/config-schema.ts': '' }, rejects(/webhook config depends on composition/));
fixture('webhook config uses primitives and the existing error owner', { 'src/config/config-schema.ts': 'export { value } from "./webhook-config.js";', 'src/config/webhook-config.ts': 'import "./config-primitives.js"; import "./config-validation-error.js"; export const value = 1;', 'src/config/config-primitives.ts': '', 'src/config/config-validation-error.ts': '' }, clean);
fixture('execution config cannot import composing schema', { 'src/config/agent-execution-config.ts': 'import "./config-schema.js";', 'src/config/config-schema.ts': '' }, rejects(/execution config depends on composition/));
fixture('execution config cannot import root API types', { 'src/config/agent-execution-config.ts': 'import type { A } from "./index.js";', 'src/config/index.ts': 'export type A = string;' }, rejects(/execution config depends on composition.*type-only/));
fixture('execution config cannot dynamically import composing schema', { 'src/config/agent-execution-config.ts': 'void import("./config-schema.js");', 'src/config/config-schema.ts': '' }, rejects(/execution config depends on composition/));
fixture('execution config depends inward on scalar and error owners', { 'src/config/config-schema.ts': 'import { value } from "./agent-execution-config.js";', 'src/config/agent-execution-config.ts': 'import "./config-primitives.js"; import "./config-validation-error.js"; export const value = 1;', 'src/config/config-primitives.ts': '', 'src/config/config-validation-error.ts': '' }, clean);
fixture('web config cannot import composing schema', { 'src/config/web-config.ts': 'import "./config-schema.js";', 'src/config/config-schema.ts': '' }, rejects(/web config depends outside scalar\/error owners/));
fixture('web config cannot import root API types', { 'src/config/web-config.ts': 'import type { A } from "./index.js";', 'src/config/index.ts': 'export type A = string;' }, rejects(/web config depends outside scalar\/error owners.*type-only/));
fixture('web config cannot dynamically import composing schema', { 'src/config/web-config.ts': 'void import("./config-schema.js");', 'src/config/config-schema.ts': '' }, rejects(/web config depends outside scalar\/error owners/));
fixture('web config cannot import search execution', { 'src/config/web-config.ts': 'import "../tools/os/web-search/index.js";', 'src/tools/os/web-search/index.ts': '' }, rejects(/web config depends outside scalar\/error owners/));
fixture('web config cannot import agent execution types', { 'src/config/web-config.ts': 'import type { A } from "../agent/agent-loop.js";', 'src/agent/agent-loop.ts': 'export type A = string;' }, rejects(/web config depends outside scalar\/error owners.*type-only/));
fixture('web config cannot dynamically import network transport', { 'src/config/web-config.ts': 'void import("../tools/os/web/web-fetch.js");', 'src/tools/os/web/web-fetch.ts': '' }, rejects(/web config depends outside scalar\/error owners/));
fixture('web config depends inward on scalar and error owners', { 'src/config/config-schema.ts': 'export { value } from "./web-config.js";', 'src/config/web-config.ts': 'import "./config-primitives.js"; import type { A } from "./config-validation-error.js"; export const value = 1;', 'src/config/config-primitives.ts': '', 'src/config/config-validation-error.ts': 'export type A = string;' }, clean);
fixture('memory config types cannot import composition', { 'src/config/memory/memory-types.ts': 'import "../config-schema.js";', 'src/config/config-schema.ts': '' }, rejects(/memory config types depend on a source owner/));
fixture('memory config types cannot import runtime types', { 'src/config/memory/memory-types.ts': 'import type { A } from "../../memory/memory-store.js";', 'src/memory/memory-store.ts': 'export type A = string;' }, rejects(/memory config types depend on a source owner.*type-only/));
fixture('memory config types cannot dynamically import an owner', { 'src/config/memory/memory-types.ts': 'void import("../index.js");', 'src/config/index.ts': '' }, rejects(/memory config types depend on a source owner/));
fixture('memory defaults cannot import composition', { 'src/config/memory/memory-defaults.ts': 'import "../config-schema.js";', 'src/config/config-schema.ts': '' }, rejects(/memory defaults depend outside their type owner/));
fixture('memory defaults cannot import parser', { 'src/config/memory/memory-defaults.ts': 'import "./memory-parser.js";', 'src/config/memory/memory-parser.ts': '' }, rejects(/memory defaults depend outside their type owner/));
fixture('memory parser cannot import composition', { 'src/config/memory/memory-parser.ts': 'import "../config-schema.js";', 'src/config/config-schema.ts': '' }, rejects(/memory parser depends outside configuration owners/));
fixture('memory parser cannot import root API types', { 'src/config/memory/memory-parser.ts': 'import type { A } from "../index.js";', 'src/config/index.ts': 'export type A = string;' }, rejects(/memory parser depends outside configuration owners.*type-only/));
fixture('memory parser cannot dynamically import prompt execution', { 'src/config/memory/memory-parser.ts': 'void import("../../prompt/build-prompt.js");', 'src/prompt/build-prompt.ts': '' }, rejects(/memory parser depends outside configuration owners/));
fixture('memory configuration composes concrete inward owners', { 'src/config/config-schema.ts': 'import "./memory/memory-defaults.js"; export { value } from "./memory/memory-parser.js";', 'src/config/memory/memory-types.ts': 'export type A = string;', 'src/config/memory/memory-defaults.ts': 'import type { A } from "./memory-types.js";', 'src/config/memory/memory-parser.ts': 'import type { A } from "./memory-types.js"; import "../config-primitives.js"; import "../config-values.js"; import "../config-validation-error.js"; import "../subcall-timeout-migration.js"; export const value = 1;', 'src/config/config-primitives.ts': '', 'src/config/config-values.ts': '', 'src/config/config-validation-error.ts': '', 'src/config/subcall-timeout-migration.ts': '' }, clean);
for (const owner of ['config-values', 'mcp-server-config']) {
  fixture(`${owner} cannot import composing schema`, { [`src/config/${owner}.ts`]: 'import "./config-schema.js";', 'src/config/config-schema.ts': '' }, rejects(/config value\/MCP owner depends on composition/));
  fixture(`${owner} cannot import root API types`, { [`src/config/${owner}.ts`]: 'import type { A } from "./index.js";', 'src/config/index.ts': 'export type A = string;' }, rejects(/config value\/MCP owner depends on composition.*type-only/));
  fixture(`${owner} cannot dynamically import composing schema`, { [`src/config/${owner}.ts`]: 'void import("./config-schema.js");', 'src/config/config-schema.ts': '' }, rejects(/config value\/MCP owner depends on composition/));
}
fixture('shared config values cannot depend on MCP config', { 'src/config/config-values.ts': 'import "./mcp-server-config.js";', 'src/config/mcp-server-config.ts': '' }, rejects(/config values depends on MCP configuration/));
fixture('MCP config depends inward on shared values and neutral types', { 'src/config/config-schema.ts': 'export { value } from "./mcp-server-config.js";', 'src/config/mcp-server-config.ts': 'import "./config-values.js"; import "./config-primitives.js"; import "./config-validation-error.js"; import type { A } from "../mcp/mcp-types.js"; export const value = 1;', 'src/config/config-values.ts': 'import "./config-primitives.js"; import "./config-validation-error.js";', 'src/config/config-primitives.ts': '', 'src/config/config-validation-error.ts': '', 'src/mcp/mcp-types.ts': 'export type A = string;' }, clean);
const localModelsNegativeCases = [
  ['types cannot import composition types', 'local-models-types', 'import type { A } from "../config-schema.js";', 'src/config/config-schema.ts', 'export type A = string;', /local models config types depend outside type owners.*type-only/],
  ['types cannot load an allowed type owner at runtime', 'local-models-types', 'import "../../local-llm/catalog/models-catalog.js";', 'src/local-llm/catalog/models-catalog.ts', '', /local models config types depend outside type owners/],
  ['types cannot dynamically load an allowed type owner', 'local-models-types', 'void import("../../local-llm/server/swa-full.js");', 'src/local-llm/server/swa-full.ts', '', /local models config types depend outside type owners/],
  ['types cannot import an arbitrary catalog type', 'local-models-types', 'import type { A } from "../../local-llm/catalog/gguf-metadata.js";', 'src/local-llm/catalog/gguf-metadata.ts', 'export type A = string;', /local models config types depend outside type owners.*type-only/],
  ['defaults cannot import composing schema', 'local-models-defaults', 'import "../config-schema.js";', 'src/config/config-schema.ts', '', /local models defaults depend outside type\/constant owners/],
  ['defaults cannot import parser types', 'local-models-defaults', 'import type { A } from "./local-models-parser.js";', 'src/config/local-models/local-models-parser.ts', 'export type A = string;', /local models defaults depend outside type\/constant owners.*type-only/],
  ['defaults cannot dynamically load download execution', 'local-models-defaults', 'void import("../../local-llm/downloads/download-file.js");', 'src/local-llm/downloads/download-file.ts', '', /local models defaults depend outside type\/constant owners/],
  ['defaults cannot load their type owner at runtime', 'local-models-defaults', 'import "./local-models-types.js";', 'src/config/local-models/local-models-types.ts', '', /local models defaults depend outside type\/constant owners/],
  ['parser cannot load their type owner at runtime', 'local-models-parser', 'import "./local-models-types.js";', 'src/config/local-models/local-models-types.ts', '', /local models parser depends outside concrete configuration helpers/],
  ['parser cannot import composition', 'local-models-parser', 'import "../config-schema.js";', 'src/config/config-schema.ts', '', /local models parser depends outside concrete configuration helpers/],
  ['parser cannot import root API types', 'local-models-parser', 'import type { A } from "../index.js";', 'src/config/index.ts', 'export type A = string;', /local models parser depends outside concrete configuration helpers.*type-only/],
  ['parser cannot dynamically load server lifecycle', 'local-models-parser', 'void import("../../local-llm/server/daemon-lifecycle.js");', 'src/local-llm/server/daemon-lifecycle.ts', '', /local models parser depends outside concrete configuration helpers/],
];
for (const [name, owner, content, target, targetContent, pattern] of localModelsNegativeCases) {
  fixture(`local models ${name}`, { [`src/config/local-models/${owner}.ts`]: content, [target]: targetContent }, rejects(pattern));
}
fixture('local models configuration composes concrete type/constant/validation owners', {
  'src/config/config-schema.ts': 'import "./local-models/local-models-defaults.js"; export { value } from "./local-models/local-models-parser.js";',
  'src/config/local-models/local-models-types.ts': 'import type { A } from "../../local-llm/catalog/models-catalog.js"; import type { A as B } from "../../local-llm/backend/windows-backend-variant.js"; import type { A as C } from "../../local-llm/server/swa-full.js"; export type T = A | B | C;',
  'src/config/local-models/local-models-defaults.ts': 'import type { T } from "./local-models-types.js"; import "../../local-llm/downloads/download-settings.js"; import "../../local-llm/catalog/huggingface-endpoint.js";',
  'src/config/local-models/local-models-parser.ts': 'import type { T } from "./local-models-types.js"; import "../config-primitives.js"; import "../config-values.js"; import "../config-validation-error.js"; import "../custom-models-schema.js"; import "../../local-llm/catalog/models-catalog.js"; import "../../local-llm/backend/windows-backend-variant.js"; import "../../local-llm/server/swa-full.js"; import "../../local-llm/downloads/download-settings.js"; import "../../local-llm/catalog/huggingface-endpoint.js"; export const value = 1;',
  'src/config/config-primitives.ts': '', 'src/config/config-values.ts': '', 'src/config/config-validation-error.ts': '', 'src/config/custom-models-schema.ts': '',
  'src/local-llm/catalog/models-catalog.ts': 'export type A = string;', 'src/local-llm/backend/windows-backend-variant.ts': 'export type A = string;', 'src/local-llm/server/swa-full.ts': 'export type A = string;',
  'src/local-llm/downloads/download-settings.ts': '', 'src/local-llm/catalog/huggingface-endpoint.ts': '',
}, clean);
for (const owner of ['tui-config', 'channel-config', 'integration-config']) {
  fixture(`${owner} cannot import composition`, { [`src/config/${owner}.ts`]: 'import "./config-schema.js";', 'src/config/config-schema.ts': '' }, rejects(/frontend config depends outside concrete value owners/));
  fixture(`${owner} cannot import composition types`, { [`src/config/${owner}.ts`]: 'import type { A } from "./index.js";', 'src/config/index.ts': 'export type A = string;' }, rejects(/frontend config depends outside concrete value owners.*type-only/));
  fixture(`${owner} cannot dynamically import runtime`, { [`src/config/${owner}.ts`]: 'void import("../runtime/runtime.js");', 'src/runtime/runtime.ts': '' }, rejects(/frontend config depends outside concrete value owners/));
  fixture(`${owner} cannot use another frontend config owner`, { [`src/config/${owner}.ts`]: 'import "./web-config.js";', 'src/config/web-config.ts': '' }, rejects(/frontend config depends outside concrete value owners/));
  const rail = owner === 'tui-config' ? { 'src/config/session-rail-config.ts': 'export type A = string;' } : {};
  fixture(`${owner} composes inward value helpers`, {
    'src/config/config-schema.ts': `import "./${owner}.js";`,
    [`src/config/${owner}.ts`]: 'import "./config-primitives.js"; import "./config-validation-error.js";' + (owner === 'tui-config' ? 'import type { A } from "./session-rail-config.js"; import "./session-rail-config.js";' : 'import "./config-values.js";'),
    'src/config/config-primitives.ts': '', 'src/config/config-validation-error.ts': '', 'src/config/config-values.ts': '', ...rail,
  }, clean);
}

for (const owner of ['agent/agent-types', 'agent/agent-defaults', 'agent/agent-parser', 'agent/compaction-config', 'http-config', 'tool-config', 'skills-config', 'session-retention-config', 'tracing-config']) {
  const up = owner.startsWith('agent/') ? '../' : './';
  fixture(`${owner} cannot import composing schema`, { [`src/config/${owner}.ts`]: `import "${up}config-schema.js";`, 'src/config/config-schema.ts': '' }, rejects(/resource config depends outside concrete configuration owners/));
  fixture(`${owner} cannot import root API types`, { [`src/config/${owner}.ts`]: `import type { A } from "${up}index.js";`, 'src/config/index.ts': 'export type A = string;' }, rejects(/resource config depends outside concrete configuration owners.*type-only/));
  fixture(`${owner} cannot dynamically load execution`, { [`src/config/${owner}.ts`]: `void import("${owner.startsWith('agent/') ? '../../' : '../'}runtime/runtime.js");`, 'src/runtime/runtime.ts': '' }, rejects(/resource config depends outside concrete configuration owners/));
}
fixture('agent type owner cannot load neutral approval types at runtime', { 'src/config/agent/agent-types.ts': 'import "../../approval/approval-level.js";', 'src/approval/approval-level.ts': '' }, rejects(/resource config depends outside concrete configuration owners/));
fixture('resource config composes only concrete value and type owners', {
  'src/config/config-schema.ts': 'import "./agent/agent-defaults.js"; import "./agent/agent-parser.js"; import "./http-config.js"; import "./tool-config.js"; import "./skills-config.js"; import "./session-retention-config.js"; import "./tracing-config.js";',
  'src/config/agent/agent-types.ts': 'import type { A } from "../../approval/approval-level.js"; import type { A as B } from "../agent-execution-config.js"; export type T = A | B;',
  'src/config/agent/agent-defaults.ts': 'import type { T } from "./agent-types.js"; import "../agent-execution-config.js";',
  'src/config/agent/agent-parser.ts': 'import type { T } from "./agent-types.js"; import type { A } from "../../approval/approval-level.js"; import "../agent-execution-config.js"; import "../config-primitives.js"; import "../config-validation-error.js";',
  ...Object.fromEntries(['http-config', 'tool-config', 'skills-config', 'session-retention-config', 'tracing-config'].map(owner => [`src/config/${owner}.ts`, 'import "./config-primitives.js"; import "./config-validation-error.js";' + (['http-config', 'tool-config', 'skills-config'].includes(owner) ? 'import "./config-values.js";' : '')])),
  'src/approval/approval-level.ts': 'export type A = number;', 'src/config/agent-execution-config.ts': 'export type A = string;', 'src/config/config-primitives.ts': '', 'src/config/config-validation-error.ts': '', 'src/config/config-values.ts': '',
}, clean);


const coreFilesystemOperations = ['read','list','glob','grep','hash','diff','watch','write','edit','patch','trash','restore','locate-project'];
for (const operation of coreFilesystemOperations) {
  const owner = `src/tools/os/fs/fs-${operation}-contract.ts`;
  const pattern = operation === 'hash' ? /hash contract depends/ : /filesystem contract must be import-free/;
  fixture(`${operation} contract cannot load execution`, { [owner]: `import "./fs-${operation}.js";`, [`src/tools/os/fs/fs-${operation}.ts`]: '' }, rejects(pattern));
  fixture(`${operation} contract cannot import composition types`, { [owner]: 'import type { A } from "../../../config/config-schema.js";', 'src/config/config-schema.ts': 'export type A = string;' }, rejects(pattern));
  fixture(`${operation} contract cannot dynamically load node IO`, { [owner]: 'void import("node:fs/promises");' }, rejects(pattern));
  fixture(`${operation} contract cannot depend on external types`, { [owner]: 'type A = import("some-external-package").A;' }, rejects(pattern));
}
fixture('core filesystem consumers can project import-free contracts', {
  ...Object.fromEntries(coreFilesystemOperations.map(operation => [`src/tools/os/fs/fs-${operation}-contract.ts`, 'export const name = "fixture";'])),
  'src/prompt/default-tool-descriptors-a.ts': coreFilesystemOperations.map(operation => `import "../tools/os/fs/fs-${operation}-contract.js";`).join('\n'),
}, clean);


for (const owner of ['runtime-inference', 'runtime-turn-service', 'runtime-tool-catalog', 'runtime-memory-services', 'runtime-observability', 'runtime-channels', 'runtime-lifecycle']) {
  const path = `src/runtime/composition/${owner}.ts`;
  fixture(`${owner} cannot import bootstrap`, { [path]: 'import "../bootstrap.js";', 'src/runtime/bootstrap.ts': '' }, rejects(/runtime component depends on composition root/));
  fixture(`${owner} cannot use bootstrap types`, { [path]: 'import type { A } from "../bootstrap.js";', 'src/runtime/bootstrap.ts': 'export type A = string;' }, rejects(/runtime component depends on composition root.*type-only/));
  fixture(`${owner} cannot dynamically load bootstrap`, { [path]: 'void import("../bootstrap.js");', 'src/runtime/bootstrap.ts': '' }, rejects(/runtime component depends on composition root/));
}
for (const statement of ['import "node:fs";', 'void import("some-package");', 'export * from "some-package";']) {
  fixture(`public runtime contract rejects runtime edge ${statement}`, { 'src/runtime/runtime-contract.ts': statement }, rejects(/public runtime contract has a runtime dependency/));
}
for (const target of ['bootstrap', 'composition/runtime-inference']) {
  fixture(`public runtime contract rejects implementation types ${target}`, { 'src/runtime/runtime-contract.ts': `import type { A } from "./${target}.js";`, [`src/runtime/${target}.ts`]: 'export type A = string;' }, rejects(/public runtime contract depends on implementation/));
}
for (const area of ['cli', 'tui', 'sidecar', 'config', 'runtime']) {
  fixture(`${area} cannot bypass public runtime API`, { [`src/${area}/consumer.ts`]: 'import type { A } from "../runtime/composition/runtime-inference.js";', 'src/runtime/composition/runtime-inference.ts': 'export type A = string;' }, rejects(/consumer bypasses public runtime contract/));
}
fixture('component cannot load public type contract at runtime', { 'src/runtime/composition/runtime-inference.ts': 'import "../runtime-contract.js";', 'src/runtime/runtime-contract.ts': '' }, rejects(/runtime component loads public type contract/));
fixture('runtime composition uses concrete owners and type-only public contract', {
  'src/runtime/bootstrap.ts': 'import "./composition/runtime-inference.js"; export { value } from "./composition/runtime-inference.js"; export type { A } from "./runtime-contract.js";',
  'src/runtime/runtime-contract.ts': 'import type { A as B } from "../session/session-store.js"; export type A = B;',
  'src/runtime/composition/runtime-inference.ts': 'import type { A } from "../runtime-contract.js"; import "./runtime-memory-services.js"; export const value = 1;',
  'src/runtime/composition/runtime-memory-services.ts': 'import "../../session/session-store.js";',
  'src/session/session-store.ts': 'export type A = string;',
}, clean);

const agentContracts = ['agent-contract.ts', 'step/step-contract.ts', 'dispatch/batch-contract.ts', 'progress/loop-contract.ts'];
for (const contract of agentContracts) {
  for (const statement of ['import "node:fs";', 'void import("some-package");']) {
    fixture(`agent contract rejects runtime edge ${contract}: ${statement}`, { [`src/agent/${contract}`]: statement }, rejects(/agent type contract has a runtime dependency/));
  }
}
for (const [owner, relative, facade] of [['agent-contract.ts','./agent-loop.js','agent-loop.ts'],['step/step-contract.ts','../step-executor.js','step-executor.ts'],['dispatch/batch-contract.ts','../batch-executor.js','batch-executor.ts']]) {
  fixture(`agent contract rejects orchestrator types ${owner}`, { [`src/agent/${owner}`]: `import type { A } from "${relative}";`, [`src/agent/${facade}`]: 'export type A = string;' }, rejects(/agent contract depends on orchestration.*type-only/));
}
for (const owner of ['step/step-inference.ts','turn/turn-preparation.ts','dispatch/batch-gates.ts','progress/loop-fingerprints.ts']) {
  fixture(`agent leaf cannot load old facade ${owner}`, { [`src/agent/${owner}`]: 'import "../agent-loop.js";', 'src/agent/agent-loop.ts': '' }, rejects(/agent leaf loads compatibility facade/));
  fixture(`agent leaf cannot load public barrel ${owner}`, { [`src/agent/${owner}`]: 'void import("../index.js");', 'src/agent/index.ts': '' }, rejects(/agent leaf loads compatibility facade/));
}
fixture('agent nominal tracker resource can be type-only in batch contract', {
  'src/agent/dispatch/batch-contract.ts': 'import type { ToolLoopTracker } from "../loop-detector.js"; export type A = ToolLoopTracker;',
  'src/agent/loop-detector.ts': 'export class ToolLoopTracker {}',
}, clean);
fixture('agent leaves use concrete owners and public contract types', {
  'src/agent/agent-loop.ts': 'import "./turn/turn-preparation.js"; export type { A } from "./agent-contract.js";',
  'src/agent/agent-contract.ts': 'import type { B } from "./step/step-contract.js"; export type A = B;',
  'src/agent/step/step-contract.ts': 'export type B = string;',
  'src/agent/turn/turn-preparation.ts': 'import type { A } from "../agent-contract.js"; import "../progress/loop-fingerprints.js";',
  'src/agent/progress/loop-fingerprints.ts': '',
}, clean);

console.log(`imports self-test: ${passed} fixtures passed`);
