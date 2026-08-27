import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from "electron";

/**
 * The native menu bar.
 *
 * It carries the same command vocabulary the renderer uses internally
 * (`room:chat`, `settings:privacy`, `runmode`, …) so a menu item and the
 * command palette cannot drift apart: both dispatch the same id, one
 * through IPC and one in-process.
 */
export function buildMenu(win: BrowserWindow, send: (command: string) => void): void {
  const item = (
    label: string,
    command: string,
    accelerator?: string,
  ): MenuItemConstructorOptions => ({
    label,
    ...(accelerator ? { accelerator } : {}),
    click: () => send(command),
  });
  const sep: MenuItemConstructorOptions = { type: "separator" };

  const template: MenuItemConstructorOptions[] = [
    {
      label: "Atomic Agent",
      submenu: [
        { role: "about" },
        item("Check for Updates…", "update"),
        sep,
        item("Settings…", "settings:general", "CommandOrControl+,"),
        item("Privacy & Approvals…", "settings:privacy", "Shift+CommandOrControl+,"),
        sep,
        { role: "services" },
        sep,
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        sep,
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        item("New Session", "session:new", "CommandOrControl+N"),
        item("New Scheduled Task…", "task:new", "Control+Command+N"),
        sep,
        item("Switch Session…", "session:switch", "CommandOrControl+O"),
        item("Open Workspace…", "workspace:choose", "Shift+CommandOrControl+O"),
        sep,
        item("Import from Hermes…", "settings:import"),
        sep,
        item("Write Debug Bundle", "dump", "Alt+Command+D"),
        sep,
        { role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        sep,
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        sep,
        item("Copy Session ID", "copy:session", "Control+Command+C"),
      ],
    },
    {
      label: "View",
      submenu: [
        item("Chat", "room:chat", "CommandOrControl+1"),
        item("Tasks", "room:tasks", "CommandOrControl+2"),
        item("Skills", "room:skills", "CommandOrControl+3"),
        item("Memory", "room:memory", "CommandOrControl+4"),
        sep,
        item("Toggle Sidebar", "toggle:sidebar", "CommandOrControl+0"),
        item("Toggle Inspector", "toggle:inspector", "Alt+Command+0"),
        item("Toggle Console", "toggle:console", "Shift+CommandOrControl+Y"),
        sep,
        item("Expand All Tool Cards", "cards:expand", "Alt+Command+E"),
        item("Collapse All Tool Cards", "cards:collapse", "Alt+Command+K"),
        sep,
        { label: "Appearance", submenu: [
          item("System", "theme:system"),
          item("Light", "theme:light"),
          item("Dark", "theme:dark"),
        ] },
        sep,
        { role: "reload" },
        { role: "toggleDevTools" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Run",
      submenu: [
        item("Send", "send", "CommandOrControl+Return"),
        item("Stop", "stop", "CommandOrControl+."),
        item("Clear Transcript", "clear", "CommandOrControl+Backspace"),
        sep,
        item("Approve Request", "appr:y", "Y"),
        item("Deny Request", "appr:n", "N"),
        sep,
        { label: "Run mode", submenu: [
          item("Local", "mode:local", "Control+1"),
          item("Cloud", "mode:cloud", "Control+2"),
          item("Fusion", "mode:fusion", "Control+3"),
          sep,
          item("Cloud Share…", "runmode", "Control+Shift+C"),
        ] },
        item("Choose Model…", "settings:models", "Shift+CommandOrControl+M"),
        item("Approval Level…", "settings:privacy"),
      ],
    },
    {
      label: "Agent",
      submenu: [
        item("Install Skill from Hub…", "skills:hub", "Shift+CommandOrControl+I"),
        item("Enable or Disable Skill…", "room:skills"),
        sep,
        item("New Scheduled Task…", "task:new"),
        sep,
        item("MCP Servers…", "settings:mcp"),
        item("Telegram…", "settings:channels"),
        sep,
        item("Built-in Tools Reference", "tools", "Alt+Command+T"),
        item("Restart Agent Runtime", "agent:restart"),
      ],
    },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, sep, { role: "front" }] },
    {
      label: "Help",
      submenu: [
        {
          label: "Atomic Agent Help",
          click: () => void shell.openExternal("https://github.com/AtomicBot-ai/atomic-agent"),
        },
        item("Keyboard Shortcuts", "shortcuts", "CommandOrControl+/"),
        sep,
        {
          label: "Report an Issue…",
          click: () =>
            void shell.openExternal("https://github.com/AtomicBot-ai/atomic-agent/issues"),
        },
      ],
    },
  ];

  if (process.platform !== "darwin") template.shift();
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  void app;
  void win;
}
