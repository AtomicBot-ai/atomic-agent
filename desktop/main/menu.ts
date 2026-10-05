import { Menu, shell, type MenuItemConstructorOptions } from "electron";

/**
 * The native menu bar.
 *
 * It carries the same command vocabulary the renderer uses internally
 * (`room:chat`, `settings:privacy`, `runmode`, …) so a menu item and the
 * command palette cannot drift apart: both dispatch the same id, one
 * through IPC and one in-process.
 */
export function buildMenu(send: (command: string) => void): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(send, process.platform)));
}

/**
 * The template, per platform. macOS keeps its app menu (About, Settings,
 * Services, Hide, Quit) and its Window menu. Windows and Linux have no app
 * menu, so what lived there moves to where those platforms keep it: Settings
 * and Privacy under Edit, Run Setup Again under File, About under Help, and
 * Exit at the bottom of File. Their Window menu drops the macOS-only roles.
 */
export function menuTemplate(send: (command: string) => void, platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  const mac = platform === "darwin";
  /* Option-chords become Shift-chords off macOS: on Windows AltGr IS
     Ctrl+Alt, so Ctrl+Alt+E would swallow the euro sign (and Ctrl+Alt+0 the
     closing brace) on a German or Polish keyboard. */
  const alt = (key: string) => (mac ? `Alt+CommandOrControl+${key}` : `Shift+CommandOrControl+${key}`);
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
        sep,
        item("Settings…", "settings:open", "CommandOrControl+,"),
        item("Privacy…", "settings:privacy", "Shift+CommandOrControl+,"),
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
        sep,
        item("Open Workspace…", "workspace:choose", "Shift+CommandOrControl+O"),
        sep,
        sep,
        ...(mac ? [] : [item("Run Setup Again…", "onboarding"), sep]),
        { role: "close" },
        ...(mac ? [] : [{ role: "quit", label: "Exit" } as MenuItemConstructorOptions]),
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
        ...(mac ? [] : [
          item("Settings…", "settings:open", "CommandOrControl+,"),
          item("Privacy…", "settings:privacy", "Shift+CommandOrControl+,"),
        ]),
      ],
    },
    {
      label: "View",
      submenu: [
        item("Chat", "room:chat", "CommandOrControl+1"),
        item("Tasks", "room:tasks", "CommandOrControl+2"),
        item("Skills", "room:skills", "CommandOrControl+3"),
        item("Memory", "settings:memory", "CommandOrControl+4"),
        sep,
        item("Toggle Sidebar", "toggle:sidebar", "CommandOrControl+0"),
        item("Toggle Inspector", "toggle:inspector", alt("0")),
        item("Toggle Console", "toggle:console", "Shift+CommandOrControl+Y"),
        sep,
        item("Expand All Tool Cards", "cards:expand", alt("E")),
        item("Collapse All Tool Cards", "cards:collapse", alt("K")),
        sep,
        { label: "Appearance", submenu: [
          item("System", "theme:system"),
          item("Light", "theme:light"),
          item("Dark", "theme:dark"),
        ] },
        sep,
        ...(process.argv.includes("--dev")
          ? ([{ role: "reload" }, { role: "toggleDevTools" }] as MenuItemConstructorOptions[])
          : []),
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Run",
      submenu: [
        /* 05.10: shown, not registered. ⌘↩ and ⌘. also answer the approval
           card on screen (Allow once, Deny), which only the page knows about;
           registered here they could fire Send / Stop alongside (Windows,
           Linux). The page's own keys run Send and Stop when no card takes
           them (renderer.js keydown: mod+Enter submit, mod+. stop), by the
           physical key on any layout (ATO-226: ⌘. is ⌘ю on a Russian one). */
        { ...item("Send", "send", "CommandOrControl+Return"), registerAccelerator: false },
        { ...item("Stop", "stop", "CommandOrControl+."), registerAccelerator: false },
        // Not off macOS: Ctrl+Backspace is delete-previous-word in every
        // Windows and Linux text field, and here it would wipe the transcript.
        item("Clear Transcript", "clear", mac ? "CommandOrControl+Backspace" : undefined),
        sep,
        item("Choose Model…", "selector:model", "Shift+CommandOrControl+M"),
        // The TUI's "Where it runs…" submenu (menu-registry.ts run.type): the
        // same switch the composer's Backend control and /runmode run.
        { label: "Where it runs…", submenu: [
          item("Local", "runmode:local"),
          item("Cloud", "runmode:cloud"),
          item("Fusion", "runmode:fusion"),
        ] },
      ],
    },
    {
      label: "Agent",
      submenu: [
        sep,
        sep,
        item("Restart Agent Runtime", "agent:restart"),
      ],
    },
    mac
      ? { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, sep, { role: "front" }] }
      : { label: "Window", submenu: [{ role: "minimize" }] },
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
        ...(mac ? [] : [sep, { role: "about" } as MenuItemConstructorOptions]),
      ],
    },
  ];

  if (!mac) template.shift();
  return template;
}
