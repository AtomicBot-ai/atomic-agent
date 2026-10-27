import {
  installSourceLabel,
  packageRemoveHint,
  type InstallSource,
} from "../update/install-source.js";

/**
 * The line the CLI plan and the TUI confirm screen both show when a deb,
 * rpm or AUR package installed the program: the plan lists data only, and
 * this names the command that removes the rest. Kept here, once, so the
 * two surfaces cannot drift. No em dashes in user-facing text.
 */
export function packagedUninstallNotice(source: InstallSource): string {
  return (
    `Installed by ${installSourceLabel(source)}, so only data is listed. ` +
    `Remove the program with: ${packageRemoveHint(source)}`
  );
}
