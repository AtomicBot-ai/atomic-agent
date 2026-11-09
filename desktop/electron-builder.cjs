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
 *                          app reads: `<channel>-mac.yml` (macOS),
 *                          `<channel>.yml` (Windows) and
 *                          `<channel>-linux*.yml` (the AppImage, ATO-573).
 *                          A person who turns on "Get beta versions" reads
 *                          `beta*` instead (ATO-575; a feed without them
 *                          falls back to the build's channel).
 *
 * ATO-241, which build this is (every team build is 0.0.1):
 *
 *   ATAG_BUILD_RUN         the workflow's run number, set by the desktop
 *   ATAG_BUILD_RUN_ID      workflow; with the commit (git, here) they go into
 *                          the app's package.json as `atagBuild`, which the
 *                          support report and Settings › General › Version
 *                          print (main/build-stamp.ts). Unset: a hand-made
 *                          build carries the commit alone.
 *
 * See desktop/README.md "App updates" for what a release must upload.
 * Signing is unchanged: mac.identity stays null here (the CI passes the
 * Developer ID with -c.mac.identity), Windows signs through
 * scripts/win-sign.cjs.
 */

const { execFileSync } = require("node:child_process");

const feedUrl = (process.env.ATAG_UPDATE_FEED_URL || "").trim().replace(/\/+$/, "");
const channel = (process.env.ATAG_UPDATE_CHANNEL || "stable").trim() || "stable";

/* The feed decides what the app installs, so it is https. The one exception
   is a test feed on the test machine itself (scripts/serve-test-feed.sh). */
if (feedUrl) {
  let url;
  try {
    url = new URL(feedUrl);
  } catch {
    throw new Error(`ATAG_UPDATE_FEED_URL is not a URL: ${feedUrl}`);
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error(`ATAG_UPDATE_FEED_URL must be https:// (http:// only for 127.0.0.1 or localhost): ${feedUrl}`);
  }
}
if (!/^[a-z0-9-]+$/.test(channel)) throw new Error(`ATAG_UPDATE_CHANNEL must be a plain name like stable or canary: ${channel}`);

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
    /* ATO-598: the tray / menu bar icon (main.ts syncTray). */
    {
      "from": "build/icons/32x32.png",
      "to": "tray.png"
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
    /* ATO-255: no space in the file name. Without this electron-builder
       uses the product name ("Atomic Agent-0.0.1-arm64-mac.zip"), GitHub
       turns the space into a dot on upload, and the update feed's
       stable-mac.yml then points at a name that 404s. Same pattern as win
       and linux; the DMG overrides it under "dmg" below. */
    "artifactName": "Atomic-Agent-${version}-${arch}-mac.${ext}",
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
      },
      /* Atomic Chat Core, fetched and checked against the release's
         SHA256SUMS by scripts/fetch-core.mjs. Per arch, like the app: the
         mac build is arm64 only, never universal. Under Resources, so the
         Developer ID pass signs it with the hardened runtime and
         entitlementsInherit like the agent, and notarization covers it. */
      {
        "from": "build/core/darwin-${arch}",
        "to": "core",
        "filter": ["atomic-chat-core"]
      }
    ]
  },
  "dmg": {
    "title": "Atomic Agent",
    "artifactName": "Atomic-Agent-${version}-${arch}.${ext}",
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
    /* ATO-252: no `arch` here on purpose. The CLI flag decides (`--win --x64`
       or `--win --arm64`), one arch per job. Pinning x64 here and passing
       `--arm64` would make one combined x64+arm64 installer, and afterPack
       has only the job's own agent bundle to copy. The arch in the file
       name keeps the two installers apart (`...-x64.exe`, `...-arm64.exe`)
       and is what electron-updater matches on (see README, update feed). */
    "target": [
      {
        "target": "nsis"
      }
    ],
    "artifactName": "Atomic-Agent-Setup-${version}-${arch}.${ext}",
    /* Atomic Chat Core (scripts/fetch-core.mjs). electron-builder's signtool
       hook only signs what it builds (the app exe, the installer, the
       uninstaller), so CI signs this file in desktop/build/core before
       packaging, the same way it signs the agent bundle. */
    "extraResources": [
      {
        "from": "build/core/win32-${arch}",
        "to": "core",
        "filter": ["atomic-chat-core.exe"]
      }
    ],
    "signtoolOptions": {
      "sign": "./scripts/win-sign.cjs",
      "signingHashAlgorithms": [
        "sha256"
      ],
      /* ATO-229: not a signing setting. electron-builder writes it into
         app-update.yml, and the installed app accepts an update's installer
         only when its signer's CN is this name (electron-updater
         verifySignature; with none set it checks nothing). The DigiCert
         certificate's CN; the desktop workflow fails the build when the
         signed installer's CN is not in this list. */
      "publisherName": [
        "AtomicMail Systems OU"
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
      "deb",
      "rpm"
    ],
    "artifactName": "Atomic-Agent-${version}-${arch}.${ext}",
    /* Atomic Chat Core (scripts/fetch-core.mjs); Linux builds are unsigned. */
    "extraResources": [
      {
        "from": "build/core/linux-${arch}",
        "to": "core",
        "filter": ["atomic-chat-core"]
      }
    ]
  },
  /* deb and rpm: the package is `atomic-agent-desktop` (package.json `name`,
     which electron-builder uses as is), installed under /opt with a
     /usr/bin/atomic-agent-desktop link, so it never collides with the CLI's
     `atomic-agent` package or /usr/bin/atomic-agent, and the two can share one
     apt/dnf repository (scripts/linux-repo.ts on main picks these files up).
     The runtime dependencies are spelled out per format because Debian and
     Fedora name them differently and electron-builder 26.15's default lists
     (gtk3, libnotify, nss, libXss, libXtst, xdg-utils, at-spi2-core, libuuid;
     libsecret on deb only) leave out ALSA, gbm and libdrm, which Electron 44
     loads at startup, and libsecret on rpm, which safeStorage needs. The
     `(a or b)` entries are rpm rich dependencies (rpm >= 4.13) naming the
     Fedora/RHEL and the openSUSE package, as electron-builder's own list does.
     electron-builder does not sign the rpm; the repository signs it. */
  "deb": {
    "packageCategory": "devel",
    "priority": "optional",
    "depends": [
      "libgtk-3-0",
      "libnotify4",
      "libnss3",
      "libxss1",
      "libxtst6",
      "xdg-utils",
      "libatspi2.0-0",
      "libuuid1",
      "libsecret-1-0",
      "libasound2",
      "libgbm1",
      "libdrm2",
      /* the bundled agent (a Node SEA under resources/agent) links libatomic
         and libstdc++; minimal Debian and Fedora images carry neither. */
      "libatomic1",
      "libstdc++6"
    ]
  },
  "rpm": {
    "packageCategory": "Development/Tools",
    "depends": [
      "gtk3",
      "libnotify",
      "nss",
      "libXScrnSaver",
      "(libXtst or libXtst6)",
      "xdg-utils",
      "at-spi2-core",
      "(libuuid or libuuid1)",
      "(libsecret or libsecret-1-0)",
      "(alsa-lib or libasound2)",
      "(mesa-libgbm or libgbm1)",
      "(libdrm or libdrm2)",
      /* the bundled agent, as above. */
      "libatomic",
      "libstdc++"
    ]
  },
  "afterPack": "scripts/after-pack.mjs"
};

/* ATO-241: the commit this was built from (the checkout's, which is the one
   the workflow's `ref` input picked, not always the run's own sha) and the run. */
function gitShortSha() {
  try {
    const out = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], { cwd: __dirname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[0-9a-f]{7,40}$/.test(out) ? out.slice(0, 8) : null;
  } catch {
    return null;
  }
}
const runNumber = (process.env.ATAG_BUILD_RUN || "").trim();
const runId = (process.env.ATAG_BUILD_RUN_ID || "").trim();
config.extraMetadata = {
  atagBuild: {
    sha: gitShortSha(),
    run: /^\d+$/.test(runNumber) ? runNumber : null,
    runId: /^\d+$/.test(runId) ? runId : null,
  },
};

/* null, not left out: with no publish key electron-builder guesses a GitHub
   publisher whenever GH_TOKEN / GITHUB_TOKEN is in the environment, and would
   write an app-update.yml nobody chose. macOS, Windows and the Linux AppImage
   read it (ATO-573); a .deb ignores it. */
config.publish = feedUrl ? [{ provider: "generic", url: feedUrl, channel }] : null;

module.exports = config;
