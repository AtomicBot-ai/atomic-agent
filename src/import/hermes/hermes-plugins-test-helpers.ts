import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Write a minimal Hermes plugin in the documented layout (plugin.yaml +
 * `register(ctx)`) for tests. Not shipped code: imported by tests only.
 */
export function writeFakeHermesPlugin(
  pluginsRoot: string,
  relDir: string,
  manifest = `name: ${relDir.split("/").pop()}\nversion: 1.0.0\n`,
): string {
  const dir = join(pluginsRoot, relDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.yaml"), manifest);
  writeFileSync(
    join(dir, "__init__.py"),
    [
      "import json",
      "from . import helpers",
      "def add(args, **kwargs):",
      "    print('stray stdout must not break the protocol')",
      "    return json.dumps({'sum': helpers.add(args['a'], args['b'])})",
      "def register(ctx):",
      "    ctx.register_tool(name='add', toolset='calc',",
      "        schema={'name': 'add', 'description': 'Add two numbers',",
      "                'parameters': {'type': 'object', 'properties': {",
      "                    'a': {'type': 'number'}, 'b': {'type': 'number'}}}},",
      "        handler=add)",
      "    ctx.register_command('greet', lambda raw: 'hi ' + raw, description='Say hi')",
      "    ctx.register_hook('post_tool_call', lambda **kw: None)",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "helpers.py"), "def add(a, b):\n    return a + b\n");
  return dir;
}
