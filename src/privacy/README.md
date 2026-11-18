# Privacy Shield

Status: current
Owner: src/privacy/

Masks personal data and keys before a request goes to a cloud model and puts them back on this machine (ATO-992 epic). Off by default: `privacy.shield.enabled` in config.json.

- [Detector](detect-private-data.ts): regex-first. `SECRET` reuses the shared credential detector ([secret detector](../error-reporting/secret-detector.ts)) by aligning its markers back to the text; `CARD` (Luhn), `IBAN` (mod 97), `EMAIL`, `PHONE` (international `+…` or a bracketed area code). Linear patterns only; a bare run of digits is never a phone. Names and street addresses need a local model and are not detected yet.
- [Vault](privacy-vault.ts): per-session reversible map. Each value gets a stable placeholder (`[EMAIL_1]`, `[CARD_1]`, `[SECRET_1]`), the same one every time, so a cloud prompt cache keeps hitting. A value masked once is masked wherever it shows up again. `unmask` restores only placeholders this vault minted; `{ json: true }` inserts values JSON-escaped for tool-call arguments. In memory only, never written to disk.
- [Stream unmasker](stream-unmasker.ts): holds back a tail that could still be a placeholder cut between two chunks (`[EMA` + `IL_1]`).
- [Registry](privacy-vault-registry.ts): one vault per session id and the process-wide "masked N" totals.

Contract: masking applies only to cloud requests; local models (llama.cpp, managed Atomic Core, a server on this machine or the local network) always get the real text. Session history keeps the real text. Precedents: Hermes vault handles (the model holds a handle, the local side the value) and Perplexity Personal Computer masking before the cloud step.

Checks: `npx vitest run src/privacy`; `npm run lint`; `npm run docs:check`.
