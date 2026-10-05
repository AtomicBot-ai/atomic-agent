/**
 * electron-builder configuration (it used to be the "build" key of
 * package.json; electron-builder finds this file by its name).
 *
 * It is a script for one reason, ATO-229: the update feed is set at build
 * time, and only when it is set.
 *
 *   ATAG_UPDATE_FEED_URL   where the update files are served from (the ONE
 *                          place to change when the hosting is decided: an
 *                          R2 bucket, a releases-only repo, ...). Unset, the
 *                          build has no `publish` entry, electron-builder
 *                          writes no app-update.yml into the app, and the
 *                          app's updater stays off ("Updates are not set up
 *                          for this build").
 *   ATAG_UPDATE_CHANNEL    `stable` by default; `canary` later. The channel
 *                          names the files electron-builder writes and the
 *                          app reads: `<channel>-mac.yml` (macOS) and
 *                          `<channel>.yml` (Windows).
 *
 * See desktop/README.md "App updates" for what a release must upload.
 * Signing is unchanged: mac.identity stays null here (the CI passes the
 * Developer ID with -c.mac.identity), Windows signs through
 * scripts/win-sign.cjs.
 */

const feedUrl = (process.env.ATAG_UPDATE_FEED_URL || "").trim().replace(/\/+$/, "");
const channel = (process.env.ATAG_UPDATE_CHANNEL || "stable").trim() || "stable";

const config = {
  "appId": "io.atomicagent.desktop",
  "productName": "Atomic Agent",
  "copyright": "Copyright (c) 2026 Atomic Bot",
  "asar": true,
  "files": [
    "out/**",
    "!out/native/**",
    "package.json",
    "LICENSE"
  ],
  "extraResources": [
    {
      "from": "LICENSE",
      "to": "LICENSE.txt"
    },
    {
      "from": "THIRD-PARTY-NOTICES.txt",
      "to": "THIRD-PARTY-NOTICES.txt"
    }
  ],
  "directories": {
    "output": "release",
    "buildResources": "build"
  },
  "npmRebuild": true,
  "mac": {
    "category": "public.app-category.productivity",
    "icon": "build/icon.icns",
    "target": [
      {
        "target": "dmg",
        "arch": [
          "arm64"
        ]
      },
      {
        "target": "zip",
        "arch": [
          "arm64"
        ]
      }
    ],
    "identity": null,
    "hardenedRuntime": true,
    "entitlements": "build/entitlements.mac.plist",
    "entitlementsInherit": "build/entitlements.mac.plist",
    "gatekeeperAssess": false,
    "extendInfo": {
      "LSMinimumSystemVersion": "14.0",
      "NSMicrophoneUsageDescription": "Atomic Agent records your voice only while you hold the microphone button in the composer, and transcribes it on this Mac.",
      "NSSpeechRecognitionUsageDescription": "Atomic Agent transcribes what you dictate using the on-device speech model. Nothing is sent to Apple."
    },
    "extraResources": [
      {
        "from": "out/native/atomic-speech",
        "to": "native/atomic-speech"
      }
    ]
  },
  "dmg": {
    "title": "Atomic Agent",
    "contents": [
      {
        "x": 170,
        "y": 265,
        "type": "file"
      },
      {
        "x": 490,
        "y": 265,
        "type": "link",
        "path": "/Applications"
      }
    ],
    "background": "build/background.png",
    "iconSize": 96,
    "window": {
      "width": 660,
      "height": 400
    }
  },
  "win": {
    "icon": "build/icon.ico",
    "target": [
      {
        "target": "nsis",
        "arch": [
          "x64"
        ]
      }
    ],
    "artifactName": "Atomic-Agent-Setup-${version}-${arch}.${ext}",
    "signtoolOptions": {
      "sign": "./scripts/win-sign.cjs",
      "signingHashAlgorithms": [
        "sha256"
      ]
    }
  },
  "nsis": {
    "oneClick": false,
    "perMachine": false,
    "allowElevation": false,
    "allowToChangeInstallationDirectory": true,
    "createDesktopShortcut": true,
    "createStartMenuShortcut": true,
    "shortcutName": "Atomic Agent",
    "uninstallDisplayName": "Atomic Agent",
    "installerIcon": "build/icon.ico",
    "uninstallerIcon": "build/icon.ico",
    "deleteAppDataOnUninstall": false
  },
  "linux": {
    "icon": "build/icons",
    "category": "Development;Utility",
    "maintainer": "Atomic Bot",
    "vendor": "Atomic Bot",
    "synopsis": "Desktop client for Atomic Agent",
    "description": "Desktop app for Atomic Agent. Starts the bundled agent locally and gives it a chat window.",
    "syncDesktopName": true,
    "target": [
      "AppImage",
      "deb"
    ],
    "artifactName": "Atomic-Agent-${version}-${arch}.${ext}"
  },
  "deb": {
    "packageCategory": "devel",
    "priority": "optional"
  },
  "afterPack": "scripts/after-pack.mjs"
};

/* null, not left out: with no publish key electron-builder guesses a GitHub
   publisher whenever GH_TOKEN / GITHUB_TOKEN is in the environment, and would
   write an app-update.yml nobody chose. Only macOS and Windows read it (the
   app's updater is off on Linux). */
config.publish = feedUrl ? [{ provider: "generic", url: feedUrl, channel }] : null;

module.exports = config;
