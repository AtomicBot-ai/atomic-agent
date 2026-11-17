#!/usr/bin/env python3
"""Serve one Hermes Agent plugin's tools as a local stdio MCP server.

Usage: python3 hermes_mcp_shim.py <plugin dir>

Atomic Agent registers this script as an MCP server per plugin, and only for
plugins the user trusted by name (`atomic-agent import hermes --trust-plugin`).
It imports the plugin the way Hermes does (`<dir>/__init__.py` as package
`hermes_plugins.<slug>`, then `register(ctx)`), but hands it a stand-in `ctx`
that only records `ctx.register_tool(...)` and `ctx.register_command(...)`.
Hooks, platforms, providers and the other registrars are accepted and ignored
(logged to stderr), so a plugin that also registers those still loads.

The MCP side is hand-written JSON-RPC 2.0 over newline-delimited stdio
(protocol 2025-06-18): initialize, notifications/initialized, ping,
tools/list, tools/call. Standard library only, no pip dependencies.

Signatures mirror Hermes' `hermes_cli/plugins_context.py`:
  register_tool(name, toolset, schema, handler, check_fn=None,
                requires_env=None, is_async=False, description="", emoji="",
                override=False)
  register_command(name, handler, description="", args_hint="",
                   argument_mode=None)
Tool handlers are `handler(args: dict, **kwargs) -> str` (a JSON string);
command handlers are `fn(raw_args: str) -> str | None`. Either may be async.
"""

from __future__ import annotations

import asyncio
import importlib.util
import inspect
import json
import logging
import os
import re
import sys
import types
from pathlib import Path
from typing import Any, Callable, Optional

PROTOCOL_VERSION = "2025-06-18"
SHIM_VERSION = "0.1.0"
COMMAND_PREFIX = "command_"
_NS_PARENT = "hermes_plugins"

# The protocol owns the real stdout. Anything a plugin prints goes to stderr,
# otherwise one stray print() would corrupt the JSON-RPC stream.
_PROTOCOL_OUT = sys.stdout
sys.stdout = sys.stderr

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="[hermes-mcp-shim] %(levelname)s %(message)s",
)
log = logging.getLogger("hermes_mcp_shim")


def _json_error(message: str) -> str:
    return json.dumps({"error": message}, ensure_ascii=False)


def _install_registry_stub() -> None:
    """Plugins often `from tools.registry import tool_error, tool_result`.
    Outside Hermes that module does not exist; provide the two helpers so
    such plugins still import. A real `tools` package on the path wins."""
    try:
        if importlib.util.find_spec("tools") is not None:
            return
    except (ImportError, ValueError):
        return
    tools_pkg = types.ModuleType("tools")
    tools_pkg.__path__ = []  # type: ignore[attr-defined]
    registry = types.ModuleType("tools.registry")

    def tool_error(message: Any, **extra: Any) -> str:
        return json.dumps({"error": str(message), **extra}, ensure_ascii=False)

    def tool_result(data: Any = None, **kwargs: Any) -> str:
        return json.dumps(data if data is not None else kwargs, ensure_ascii=False)

    registry.tool_error = tool_error  # type: ignore[attr-defined]
    registry.tool_result = tool_result  # type: ignore[attr-defined]
    tools_pkg.registry = registry  # type: ignore[attr-defined]
    sys.modules["tools"] = tools_pkg
    sys.modules["tools.registry"] = registry


class _Tool:
    def __init__(
        self,
        name: str,
        description: str,
        input_schema: dict,
        handler: Callable,
        is_async: bool,
        kind: str,
    ) -> None:
        self.name = name
        self.description = description
        self.input_schema = input_schema
        self.handler = handler
        self.is_async = is_async
        self.kind = kind  # "tool" | "command"


class ShimContext:
    """Stand-in for Hermes' PluginContext: records tools and commands."""

    def __init__(self, plugin_dir: Path, plugin_name: str) -> None:
        self.plugin_id = plugin_name
        self.manifest = types.SimpleNamespace(
            name=plugin_name, path=str(plugin_dir), source="user"
        )
        self.tools: dict[str, _Tool] = {}

    def register_tool(
        self,
        name: str,
        toolset: str,
        schema: dict,
        handler: Callable,
        check_fn: Optional[Callable] = None,
        requires_env: Optional[list] = None,
        is_async: bool = False,
        description: str = "",
        emoji: str = "",
        override: bool = False,
        **_extra: Any,
    ) -> None:
        if not isinstance(schema, dict):
            log.warning("tool %r: schema must be a dict, skipped", name)
            return
        params = schema.get("parameters")
        if params is not None and not isinstance(params, dict):
            log.warning("tool %r: schema['parameters'] must be a dict, skipped", name)
            return
        missing = [
            env for env in (requires_env or [])
            if isinstance(env, str) and not os.environ.get(env)
        ]
        if missing:
            log.warning("tool %r hidden: missing env %s", name, ", ".join(missing))
            return
        if check_fn is not None:
            try:
                if not check_fn():
                    log.info("tool %r hidden: check_fn returned false", name)
                    return
            except Exception as exc:  # noqa: BLE001 - plugin code
                log.warning("tool %r hidden: check_fn raised %s", name, exc)
                return
        self.tools[name] = _Tool(
            name=name,
            description=description or str(schema.get("description", "")),
            input_schema=params or {"type": "object", "properties": {}},
            handler=handler,
            is_async=is_async,
            kind="tool",
        )

    def register_command(
        self,
        name: str,
        handler: Callable,
        description: str = "",
        args_hint: str = "",
        argument_mode: Optional[str] = None,
        **_extra: Any,
    ) -> None:
        clean = name.lower().strip().lstrip("/").replace(" ", "-")
        if not clean:
            return
        tool_name = COMMAND_PREFIX + re.sub(r"[^a-z0-9_-]", "_", clean)
        hint = f" Arguments: {args_hint}." if args_hint else ""
        self.tools[tool_name] = _Tool(
            name=tool_name,
            description=(
                f"Hermes slash command /{clean}: {description or 'Plugin command'}.{hint}"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "args": {
                        "type": "string",
                        "description": "Text typed after the command name.",
                    }
                },
            },
            handler=handler,
            is_async=False,
            kind="command",
        )

    def dispatch_tool(self, tool_name: str, args: dict, **_kwargs: Any) -> str:
        tool = self.tools.get(tool_name)
        if tool is None or tool.kind != "tool":
            return _json_error(
                f"tool {tool_name!r} is not available outside Hermes"
            )
        return _result_text(_invoke(tool, args))

    def __getattr__(self, attr: str) -> Any:
        # Every other registrar (hooks, platforms, providers, middleware, ...)
        # is accepted and ignored so plugins that use them still load.
        if attr.startswith("register_"):
            def _ignored(*_args: Any, **_kwargs: Any) -> None:
                log.info("ctx.%s is not supported by the bridge; ignored", attr)
                return None

            return _ignored
        raise AttributeError(attr)


def _read_manifest_name(plugin_dir: Path) -> str:
    for fname in ("plugin.yaml", "plugin.yml"):
        path = plugin_dir / fname
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            match = re.match(r"^name:\s*(.+?)\s*$", line)
            if match:
                return match.group(1).strip("'\"")
    return plugin_dir.name


def load_plugin(plugin_dir: Path) -> ShimContext:
    init_file = plugin_dir / "__init__.py"
    if not init_file.is_file():
        raise FileNotFoundError(f"No __init__.py in {plugin_dir}")
    _install_registry_stub()
    name = _read_manifest_name(plugin_dir)
    slug = re.sub(r"[^A-Za-z0-9_]", "_", plugin_dir.name) or "plugin"
    if _NS_PARENT not in sys.modules:
        ns_pkg = types.ModuleType(_NS_PARENT)
        ns_pkg.__path__ = []  # type: ignore[attr-defined]
        ns_pkg.__package__ = _NS_PARENT
        sys.modules[_NS_PARENT] = ns_pkg
    module_name = f"{_NS_PARENT}.{slug}"
    spec = importlib.util.spec_from_file_location(
        module_name, init_file, submodule_search_locations=[str(plugin_dir)]
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot create module spec for {init_file}")
    module = importlib.util.module_from_spec(spec)
    module.__package__ = module_name
    module.__path__ = [str(plugin_dir)]  # type: ignore[attr-defined]
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    register_fn = getattr(module, "register", None)
    if not callable(register_fn):
        raise ImportError(f"Plugin {name!r} has no register() function")
    ctx = ShimContext(plugin_dir, name)
    register_fn(ctx)
    return ctx


def _invoke(tool: _Tool, args: dict) -> Any:
    if tool.kind == "command":
        raw = args.get("args", "")
        result = tool.handler(raw if isinstance(raw, str) else str(raw))
    else:
        result = tool.handler(args)
    if tool.is_async or inspect.isawaitable(result):
        result = asyncio.run(_await(result))
    return result


async def _await(value: Any) -> Any:
    return await value


def _result_text(result: Any) -> str:
    if result is None:
        return ""
    if isinstance(result, str):
        return result
    return json.dumps(result, ensure_ascii=False, default=str)


def _call_result(tool: _Tool, args: dict) -> dict:
    try:
        result = _invoke(tool, args)
    except Exception as exc:  # noqa: BLE001 - plugin code
        log.exception("tool %s failed", tool.name)
        return {
            "content": [
                {"type": "text", "text": f"Tool execution failed: {type(exc).__name__}: {exc}"}
            ],
            "isError": True,
        }
    # Hermes' multimodal envelope: {"_multimodal": True, "content": [...]}.
    if (
        isinstance(result, dict)
        and result.get("_multimodal") is True
        and isinstance(result.get("content"), list)
    ):
        parts = []
        for part in result["content"]:
            if isinstance(part, dict) and part.get("type") == "text":
                parts.append({"type": "text", "text": str(part.get("text", ""))})
            else:
                parts.append({"type": "text", "text": _result_text(part)})
        return {"content": parts, "isError": False}
    text = _result_text(result)
    is_error = False
    try:
        parsed = json.loads(text)
        is_error = isinstance(parsed, dict) and set(parsed.keys()) <= {
            "error", "error_type", "tool", "result_type"
        } and "error" in parsed
    except (ValueError, TypeError):
        pass
    return {"content": [{"type": "text", "text": text}], "isError": is_error}


def _send(message: dict) -> None:
    _PROTOCOL_OUT.write(json.dumps(message, ensure_ascii=False) + "\n")
    _PROTOCOL_OUT.flush()


def _reply(req_id: Any, result: dict) -> None:
    _send({"jsonrpc": "2.0", "id": req_id, "result": result})


def _reply_error(req_id: Any, code: int, message: str) -> None:
    _send({"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}})


def handle(ctx: ShimContext, message: Any) -> None:
    if not isinstance(message, dict):
        _reply_error(None, -32600, "invalid request")
        return
    method = message.get("method")
    req_id = message.get("id")
    is_notification = "id" not in message
    if is_notification:
        return  # notifications/initialized, notifications/cancelled, ...
    params = message.get("params") or {}
    if method == "initialize":
        _reply(req_id, {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": f"hermes-plugin-{ctx.plugin_id}", "version": SHIM_VERSION},
        })
    elif method == "ping":
        _reply(req_id, {})
    elif method == "tools/list":
        _reply(req_id, {
            "tools": [
                {"name": t.name, "description": t.description, "inputSchema": t.input_schema}
                for t in ctx.tools.values()
            ]
        })
    elif method == "tools/call":
        name = params.get("name")
        tool = ctx.tools.get(name) if isinstance(name, str) else None
        if tool is None:
            _reply_error(req_id, -32602, f"unknown tool: {name}")
            return
        args = params.get("arguments") or {}
        if not isinstance(args, dict):
            _reply_error(req_id, -32602, "arguments must be an object")
            return
        _reply(req_id, _call_result(tool, args))
    else:
        _reply_error(req_id, -32601, f"method not found: {method}")


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        sys.stderr.write("usage: hermes_mcp_shim.py <plugin dir>\n")
        return 2
    plugin_dir = Path(argv[1]).expanduser().resolve()
    try:
        ctx = load_plugin(plugin_dir)
    except Exception as exc:  # noqa: BLE001 - surface any import failure
        log.exception("failed to load plugin at %s: %s", plugin_dir, exc)
        return 1
    log.info("loaded %s: %d tool(s)", ctx.plugin_id, len(ctx.tools))
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            _reply_error(None, -32700, "parse error")
            continue
        try:
            handle(ctx, message)
        except Exception as exc:  # noqa: BLE001 - never die on one bad request
            log.exception("request failed")
            if isinstance(message, dict) and "id" in message:
                _reply_error(message.get("id"), -32603, f"internal error: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
