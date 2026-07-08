/**
 * Window control surface for the frameless BrowserWindow. The renderer's
 * custom title bar drives min/max/close through these channels since the
 * native chrome is disabled (`frame: false`).
 */
export interface WindowBridge {
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizeChange: (callback: (maximized: boolean) => void) => () => void;
  platform: NodeJS.Platform;
}
