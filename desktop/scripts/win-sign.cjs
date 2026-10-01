/**
 * electron-builder `win.signtoolOptions.sign` hook.
 *
 * electron-builder calls this for every Windows file it signs: the app exe
 * (after it edits the icon and version resources), the NSIS installer and the
 * uninstaller. The certificate lives in DigiCert KeyLocker, not in a .pfx, so
 * electron-builder's built-in signtool call cannot reach it. CI sets KeyLocker
 * up (smctl, certsync, signtool on PATH; see .github/workflows/desktop.yml)
 * and this signs by thumbprint, the same way release.yml signs the agent.
 *
 * Without SM_CODE_SIGNING_CERT_SHA1_HASH (a local `electron-builder --win`, or
 * a fork without the secrets) it signs nothing and says so; the build still
 * produces a working, unsigned installer.
 */
const { execFileSync } = require("node:child_process");

module.exports = async function sign(configuration) {
  const file = configuration.path;
  const thumbprint = process.env.SM_CODE_SIGNING_CERT_SHA1_HASH;
  if (!thumbprint) {
    console.log(`  • not signing ${file}: SM_CODE_SIGNING_CERT_SHA1_HASH is not set`);
    return;
  }
  // execFileSync throws on a non-zero exit, which fails the build.
  execFileSync(
    "signtool",
    ["sign", "/sha1", thumbprint, "/tr", "http://timestamp.digicert.com", "/td", "SHA256", "/fd", "SHA256", file],
    { stdio: "inherit" },
  );
  execFileSync("signtool", ["verify", "/pa", file], { stdio: "inherit" });
};
