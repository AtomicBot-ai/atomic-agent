/* ATO-2530: Settings › Models says where a saved key comes from when it is
   not a plain key in .env: "from 1Password" for a key saved as op://…,
   Bitwarden (bw://), Vault (vault://), the user's own command (cmd://), or
   the system keychain. The labels come from main (secret-source-labels.ts
   via app:dotenvKeys `sources`); no value ever reaches this window.
   Declares functions only; renderer.js calls secretSourceChip. */

/* The words per source. The keychain is named the way each system names it. */
function secretSourceWords(platform) {
  const keychain = platform === 'win32' ? 'Credential Manager' : platform === 'darwin' ? 'Keychain' : 'the system keyring';
  return {
    '1password': 'from 1Password',
    bitwarden: 'from Bitwarden',
    vault: 'from Vault',
    command: 'from your command',
    keychain: 'in ' + keychain,
  };
}

/* The label for the first of `names` that has a source, or '' (a plain .env key). */
function secretSourceLabel(names, sources, platform) {
  if (!sources || typeof sources !== 'object') return '';
  const words = secretSourceWords(platform);
  for (const name of names || []) {
    const source = Object.prototype.hasOwnProperty.call(sources, name) ? sources[name] : null;
    if (source && Object.prototype.hasOwnProperty.call(words, source)) return words[source];
  }
  return '';
}

/* A neutral chip after "Key saved", or '' when there is nothing to say. `esc` and `chip` are renderer.js's. */
function secretSourceChip(names, sources, platform, chipFn, escFn) {
  const label = secretSourceLabel(names, sources, platform);
  return label ? ' ' + chipFn('line', escFn(label)) : '';
}

if (typeof module !== 'undefined') {
  module.exports = {secretSourceWords, secretSourceLabel, secretSourceChip};
}
