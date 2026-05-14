import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalCase } from "../harness/case-schema.js";

// Three .txt files contain three unique emails (plus noise). Agent must
// grep/scan all .txt and emit the set. We assert each email appears in
// the reply at least once.
const FILES: Record<string, string> = {
  "notes/team.txt": "Lead: alice@example.com\nbackup: bob@corp.io\nnot an email: bob@\n",
  "notes/contacts.txt": "primary alice@example.com\nsecondary carol@mail.co.uk\n",
  "notes/footer.txt": "footer.md says: ping carol@mail.co.uk if blocked\n",
};

const EXPECTED = ["alice@example.com", "bob@corp.io", "carol@mail.co.uk"];

export const osFsExtractEmails: EvalCase = {
  id: "os-fs-extract-emails",
  name: "Extract unique email addresses from .txt files",
  category: "os",
  prompt: `Find every unique email address that appears in any .txt file under notes/. List them, one per line.`,
  setup: ({ workingDir }) => {
    for (const [rel, body] of Object.entries(FILES)) {
      const full = join(workingDir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, body, "utf8");
    }
  },
  expectations: EXPECTED.map((email) => ({
    kind: "reply_contains" as const,
    pattern: new RegExp(email.replace(/\./g, "\\.")),
  })),
};
