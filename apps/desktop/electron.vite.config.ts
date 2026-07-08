import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const platform = process.platform;

/**
 * Global constants that ported Jan components read at runtime. Jan sets
 * these from Tauri env; in Electron we hardcode the non-Tauri profile and
 * derive the OS flags from `process.platform`. The ambient type side lives
 * in `src/renderer/types/global.d.ts`.
 */
const rendererDefine = {
  IS_TAURI: JSON.stringify(false),
  IS_WEB_APP: JSON.stringify(false),
  IS_DEV: JSON.stringify(process.env.NODE_ENV !== "production"),
  IS_MACOS: JSON.stringify(platform === "darwin"),
  IS_WINDOWS: JSON.stringify(platform === "win32"),
  IS_LINUX: JSON.stringify(platform === "linux"),
  IS_IOS: JSON.stringify(false),
  IS_ANDROID: JSON.stringify(false),
  PLATFORM: JSON.stringify(platform),
  VERSION: JSON.stringify(process.env.npm_package_version ?? "0.0.0"),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@agent": resolve(__dirname, "../../src"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@agent": resolve(__dirname, "../../src"),
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        "@agent": resolve(__dirname, "../../src"),
        "@": resolve(__dirname, "src/renderer"),
      },
    },
    define: rendererDefine,
    plugins: [react(), tailwindcss()],
  },
});
