/**
 * English, the source of truth (ATO-571). Every key the interface asks for
 * lives here; another language may leave a key out and `t()` falls back to
 * this text. Keys are grouped by surface with a dotted prefix.
 *
 * `{name}` marks a value filled in at the call site. Product names, key
 * names (`enter`, `esc`, `ctrl+c`) and commands are not translated.
 */
export const en = {
  // Onboarding: the header subtitle of each step.
  "onboarding.subtitle.choose": "setup · step 1 of 2",
  "onboarding.subtitle.localPick": "local models · step 2 of 2",
  "onboarding.subtitle.localHfRef": "local models · hugging face",
  "onboarding.subtitle.localHfPick": "local models · choose a file",
  "onboarding.subtitle.localDownload": "local models · downloading",
  "onboarding.subtitle.proposeSecond": "one more thing",
  "onboarding.subtitle.waitOrJump": "almost there",
  "onboarding.subtitle.importPick": "bring your data · one last step",
  "onboarding.subtitle.importDone": "bring your data · done",
  "onboarding.subtitle.cloud": "cloud model · step 2 of 2",
  "onboarding.subtitle.customChatUrl": "custom endpoint · step 2 of 2",
  "onboarding.subtitle.customEmbeddingUrl": "custom endpoint · embeddings",
  "onboarding.subtitle.finished": "setting up…",

  // Onboarding: the key-hint footer.
  "onboarding.footer.quit": "ctrl+c quit",
  "onboarding.footer.quitArmed": "ctrl+c press again to quit",
  "onboarding.footer.choose": "↑/↓ move   enter select   1–3 jump   esc skip   {quit}",
  "onboarding.footer.listSearch": "↑/↓ move   / search   enter select   esc back   {quit}",
  "onboarding.footer.list": "↑/↓ move   enter select   esc back   {quit}",
  "onboarding.footer.customChatUrl": "enter test & continue   esc back   {quit}",
  "onboarding.footer.customEmbeddingUrl": "enter test & save   empty enter skips embeddings   esc back   {quit}",
  "onboarding.footer.hfLookupBusy": "esc cancel the lookup   {quit}",
  "onboarding.footer.hfRef": "enter look it up   {clear}esc back   {quit}",
  "onboarding.footer.hfClear": "ctrl+l clear",
  "onboarding.footer.hfPick": "↑/↓ move   enter download   esc back   {quit}",
  "onboarding.footer.localDownload": "c set up cloud meanwhile   s skip to the agent   {quit}",
  "onboarding.footer.proposeSecond": "↑/↓ move   enter select   esc skip   {quit}",
  "onboarding.footer.importBusy": "importing…   {quit}",
  "onboarding.footer.importPick": "↑/↓ move   space tick   enter import   esc skip   {quit}",
  "onboarding.footer.importDone": "any key to start   {quit}",
  "onboarding.footer.waitOrJump": "↑/↓ move   enter start or add a provider   {quit}",

  // Onboarding: the first screen.
  "onboarding.intro.pressAnyKey": "[ press any key to continue ]",

  // Onboarding: where the model runs. The explainer is hand-wrapped.
  "onboarding.choose.explainer1": "atomic-agent can drive models three ways. Nothing here is permanent — you",
  "onboarding.choose.explainer2": "can add the others at any time from the menu.",
  "onboarding.choose.local.label": "Local models",
  "onboarding.choose.local.detail1": "Runs on this machine. Private, no key, free per token.",
  "onboarding.choose.local.detail2": "Answers in a minute; a bigger model follows on its own.",
  "onboarding.choose.cloud.label": "Cloud models",
  "onboarding.choose.cloud.detail1": "OpenRouter, Anthropic, Gemini, Groq and 20 more.",
  "onboarding.choose.cloud.detail2": "Fastest to a working agent — needs an API key.",
  "onboarding.choose.custom.label": "Custom endpoint",
  "onboarding.choose.custom.detail1": "An OpenAI-compatible or llama-server URL you already run.",
  "onboarding.choose.custom.detail2": "Nothing is downloaded, nothing else is asked.",
  "onboarding.choose.custom.found": "Found running here: {servers}.",
} as const;

export type MessageKey = keyof typeof en;
