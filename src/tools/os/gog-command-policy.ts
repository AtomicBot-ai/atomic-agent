const SAFE_GOG_ENABLE_COMMANDS: ReadonlySet<string> = new Set([
  "calendar.events",
  "drive.get",
  "drive.inventory",
  "drive.tree",
  "gmail.get",
  "gmail.search",
]);

const GOG_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "--account",
  "--config",
  "--enable-commands",
  "--keyring-backend",
  "--keyring-dir",
]);

const DANGEROUS_GOG_WORDS: ReadonlySet<string> = new Set([
  "add",
  "create",
  "credentials",
  "delete",
  "draft",
  "grant",
  "login",
  "manage",
  "modify",
  "patch",
  "remove",
  "send",
  "share",
  "trash",
  "update",
]);

export function isGogCommand(cmd: string): boolean {
  const normalised = cmd.replace(/\\/g, "/");
  const basename = normalised.slice(normalised.lastIndexOf("/") + 1);
  return basename === "gog";
}

export function shouldAutoApproveGogCommand(
  cmd: string,
  args: readonly string[],
): boolean {
  if (!isGogCommand(cmd)) return false;
  if (isSafeAuthRead(args)) return true;
  if (!args.includes("--no-input")) return false;
  if (containsDangerousWord(args)) return false;
  const enabled = readEnabledCommands(args);
  if (enabled.length === 0) return false;
  return enabled.every((name) => SAFE_GOG_ENABLE_COMMANDS.has(name));
}

function isSafeAuthRead(args: readonly string[]): boolean {
  const command = readCommandWords(args);
  return command[0] === "auth" && (command[1] === "list" || command[1] === "doctor");
}

function readCommandWords(args: readonly string[]): string[] {
  const words: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (GOG_OPTIONS_WITH_VALUE.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    words.push(arg);
  }
  return words;
}

function containsDangerousWord(args: readonly string[]): boolean {
  for (const word of readCommandWords(args)) {
    if (DANGEROUS_GOG_WORDS.has(word)) return true;
  }
  return false;
}

function readEnabledCommands(args: readonly string[]): string[] {
  const idx = args.indexOf("--enable-commands");
  if (idx === -1) return [];
  const raw = args[idx + 1];
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
