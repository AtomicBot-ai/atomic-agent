import { describe, expect, it } from "vitest";

import {
  knownSecretsFromEnv,
  maskSecrets,
  redactedMarker,
  type KnownSecret,
} from "./secret-detector.js";

// Fake credentials are assembled from parts so no complete key-shaped
// literal sits in the source for a secret scanner to flag.
const OPENAI = "sk-proj-" + "Ab12Cd34Ef56Gh78Ij90Kl12Mn34";
const OPENAI_CLASSIC = "sk-" + "Zy98Xw76Vu54Ts32Rq10Po98";
const ANTHROPIC = "sk-ant-" + "api03-Ab12Cd34Ef56Gh78Ij90_Kl12";
const OPENROUTER = "sk-or-" + "v1-" + "0123456789abcdef".repeat(4);
const GITHUB_PAT = "ghp_" + "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78";
const GITHUB_OAUTH = "gho_" + "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78";
const GITHUB_FINE = "github_" + "pat_" + "11ABCDEFG0" + "_Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56";
const SLACK_BOT = "xox" + "b-" + "123456789012-1234567890123-Ab12Cd34Ef56Gh78";
const SLACK_USER = "xox" + "p-" + "123456789012-1234567890123-Ab12Cd34Ef56Gh78";
const AWS = "AKIA" + "IOSFODNN7EXAMPLE";
const GOOGLE = "AIza" + "SyA-0123456789abcdefghijklmnopqrstu";
const HF = "hf_" + "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56";
const JWT =
  "eyJ" + "hbGciOiJIUzI1NiJ9" + ".eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0" + ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const PEM_BODY = "MIIEpAIBAAKCAQEA1234567890abcdefABCDEF+/xyz\nQWERTYuiop0987654321asdfghjklZXCVBNM==";

describe("maskSecrets: vendor key shapes", () => {
  it.each([
    ["OpenAI project key", OPENAI, "openai-key"],
    ["sk- key of an OpenAI-shaped service", OPENAI_CLASSIC, "api-key"],
    ["Anthropic key", ANTHROPIC, "anthropic-key"],
    ["OpenRouter key", OPENROUTER, "openrouter-key"],
    ["GitHub classic token", GITHUB_PAT, "github-token"],
    ["GitHub OAuth token", GITHUB_OAUTH, "github-token"],
    ["GitHub fine-grained token", GITHUB_FINE, "github-token"],
    ["Slack bot token", SLACK_BOT, "slack-token"],
    ["Slack user token", SLACK_USER, "slack-token"],
    ["AWS access key id", AWS, "aws-access-key"],
    ["Google API key", GOOGLE, "google-key"],
    ["Hugging Face token", HF, "hf-token"],
    ["JWT", JWT, "jwt"],
  ])("replaces a %s with a labelled marker", (_name, secret, label) => {
    const out = maskSecrets(`found ${secret} in the log`);
    expect(out).toBe(`found ${redactedMarker(label)} in the log`);
    expect(out).not.toContain(secret);
  });

  it("masks a bearer token and keeps the scheme", () => {
    expect(maskSecrets("Authorization: Bearer abcDEF123456ghiJKL789xyz")).toBe(
      "Authorization: Bearer [redacted:bearer-token]",
    );
    expect(maskSecrets(`-H "authorization: bearer ${"t0ken".repeat(5)}"`)).toBe(
      '-H "authorization: bearer [redacted:bearer-token]"',
    );
  });

  it("masks Basic credentials only after an Authorization header", () => {
    expect(maskSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA==")).toBe(
      "Authorization: Basic [redacted:basic-auth]",
    );
  });

  it("stops a Cookie value at a JSON-escaped line break and its closing quote", () => {
    expect(maskSecrets('{"headers":"Cookie: sid=abc123def456\\r\\nHost: x.io"}')).toBe(
      '{"headers":"Cookie: [redacted:cookie]\\r\\nHost: x.io"}',
    );
    expect(maskSecrets('"Cookie: sid=abc123def456", next')).toBe('"Cookie: [redacted:cookie]", next');
  });

  it("masks Cookie and Set-Cookie header values", () => {
    expect(maskSecrets("> Cookie: sid=abc123def456; theme=dark")).toBe("> Cookie: [redacted:cookie]");
    expect(maskSecrets("< Set-Cookie: sid=zzz999yyy888; Path=/; HttpOnly")).toBe(
      "< Set-Cookie: [redacted:cookie]",
    );
  });

  it("removes a PEM private key block whole, in plain and JSON-escaped form", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----`;
    expect(maskSecrets(`key:\n${pem}\nafter`)).toBe("key:\n[redacted:private-key]\nafter");
    const escaped = `{"private_key":"-----BEGIN PRIVATE KEY-----\\n${PEM_BODY.replace("\n", "\\n")}\\n-----END PRIVATE KEY-----\\n"}`;
    const out = maskSecrets(escaped);
    expect(out).toContain("[redacted:private-key]");
    expect(out).not.toContain("MIIEpAIBAAKCAQEA");
  });

  it("removes a PEM block clipped before its END line", () => {
    const out = maskSecrets(`-----BEGIN OPENSSH PRIVATE KEY-----\n${PEM_BODY}`);
    expect(out).toBe("[redacted:private-key]");
  });
});

describe("maskSecrets: names that say secret", () => {
  it("masks .env lines and keeps the names", () => {
    const env = [
      "DB_PASSWORD=hunter2secret",
      "export STRIPE_SECRET='s3cr3t pa55'",
      'CLIENT_SECRET="Q1w2E3r4T5y6"',
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    ].join("\n");
    expect(maskSecrets(env)).toBe(
      [
        "DB_PASSWORD=[redacted:secret]",
        "export STRIPE_SECRET='[redacted:secret]'",
        'CLIENT_SECRET="[redacted:secret]"',
        "AWS_SECRET_ACCESS_KEY=[redacted:secret]",
      ].join("\n"),
    );
  });

  it("masks JSON and YAML fields, CLI flags and query parameters", () => {
    expect(maskSecrets('{"apiKey": "abcd1234efgh5678", "user": "alice"}')).toBe(
      '{"apiKey": "[redacted:secret]", "user": "alice"}',
    );
    expect(maskSecrets("db:\n  password: s3cr3tpass99")).toBe("db:\n  password: [redacted:secret]");
    expect(maskSecrets("curl --password=s3cretPassw0rd https://x.io/?access_token=abcd1234efgh&page=2")).toBe(
      "curl --password=[redacted:secret] https://x.io/?access_token=[redacted:secret]&page=2",
    );
    expect(maskSecrets('{"x-api-key": "k3y-Value-1234"}')).toBe('{"x-api-key": "[redacted:secret]"}');
  });

  it("masks the password of a URL and keeps the user and host", () => {
    expect(maskSecrets("postgres://app:hunter2secret@db.local:5432/main")).toBe(
      "postgres://app:[redacted:password]@db.local:5432/main",
    );
    expect(maskSecrets("redis://:p4ssw0rd@cache:6379")).toBe("redis://:[redacted:password]@cache:6379");
  });

  it("keeps a vendor label when the key sits in a secret-named pair or a URL", () => {
    expect(maskSecrets(`OPENROUTER_API_KEY=${OPENROUTER}`)).toBe("OPENROUTER_API_KEY=[redacted:openrouter-key]");
    expect(maskSecrets(`https://x-access-token:${GITHUB_PAT}@github.com/o/r.git`)).toBe(
      "https://x-access-token:[redacted:github-token]@github.com/o/r.git",
    );
  });
});

describe("maskSecrets: values the agent knows", () => {
  const known: KnownSecret[] = [
    { label: "OPENROUTER_API_KEY", value: "Zq9xVv81LmNbTt42" },
    { label: "work-key", value: "Zq9xVv81LmNbTt42-long-form" },
  ];

  it("replaces an exact known value, whatever its shape, longest first", () => {
    expect(maskSecrets("a Zq9xVv81LmNbTt42 b Zq9xVv81LmNbTt42-long-form c", known)).toBe(
      "a [redacted:OPENROUTER_API_KEY] b [redacted:work-key] c",
    );
  });

  it("ignores known values too short or too plain to match safely", () => {
    const weak: KnownSecret[] = [
      { label: "SHORT_TOKEN", value: "abc1" },
      { label: "CREDENTIAL_HELPER", value: "osxkeychain" },
      { label: "MAX_TOKENS", value: "123456789" },
      { label: "SECRET_DIR", value: "/var/lib/secrets" },
    ];
    const text = "abc1 osxkeychain 123456789 /var/lib/secrets";
    expect(maskSecrets(text, weak)).toBe(text);
  });

  it("collects secret-named variables from an env, with their names as labels", () => {
    expect(
      knownSecretsFromEnv({
        OPENAI_API_KEY: "abc12345678",
        GH_TOKEN: "short",
        PATH: "/usr/bin:/bin",
        HOME: "/home/u",
      }),
    ).toEqual([{ label: "OPENAI_API_KEY", value: "abc12345678" }]);
  });
});

describe("maskSecrets: ordinary output is left alone", () => {
  it.each([
    ["a git log", "commit 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39\nAuthor: A <a@b.c>\n\n    fix: token refresh"],
    ["a sha256sum line", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  model.gguf"],
    ["UUIDs", "id=550e8400-e29b-41d4-a716-446655440000 trace 123e4567-e89b-12d3-a456-426614174000"],
    ["token counts and settings", "MAX_TOKENS=4096\nmax_tokens: 8192\n\"token_type\": \"bearer\"\nTOKENIZER=gpt2-tokenizer-v1"],
    ["paths, URLs and references", "SECRET_FILE=/run/secrets/db\nTOKEN_URL=https://auth.example.com/token\nAPI_KEY=$OPENAI_API_KEY\nPASSWORD=${DB_PASS}"],
    ["placeholders", "API_KEY=<your-api-key>\nPASSWORD=********\nTOKEN=xxxxxxxxxxxx\nsecret: true"],
    ["object and cache keys", '{"key": "uploads/2024/a.png", "cache_key": "550e8400-e29b-41d4-a716-446655440000", "sort_key": "createdAt_desc"}'],
    ["slugs that start with sk-", "risk-assessment-v2 disk-cache-0123456789abcdef sk-loading-spinner-component-large"],
    ["a CSS class that starts with sk-", '<div class="sk-skeleton-loader-row-2xl sk-pulse-animation-delay-300ms">'],
    ["a cookie in code", "const opts = { cookie: req.headers.cookie, cookies: enabled };"],
    [
      "TypeScript",
      [
        "const token = getToken();",
        "const opts = { password: user.password, apiKey: process.env.OPENAI_API_KEY, secret: config.secret2 };",
        "function login(password: string, token?: AccessToken) {}",
        "export const API_KEY = readKey(process.env);",
      ].join("\n"),
    ],
    [
      "Python",
      [
        "def check(password: Optional[str], token: str = DEFAULT_TOKEN) -> bool:",
        "    password = PasswordField(max_length=128)",
        "    api_key = os.environ['OPENAI_API_KEY']",
        "    self.secret = settings.SECRET_KEY",
      ].join("\n"),
    ],
    [
      "Go",
      [
        "token, err := auth.NewToken(ctx)",
        'cfg := Config{Password: os.Getenv("DB_PASSWORD"), APIKey: flags.APIKey}',
        "secret := s.secrets[name]",
      ].join("\n"),
    ],
    [
      "UI strings under secret names",
      [
        '"password": "Enter your password here"',
        '"token": "Your session has expired, sign in again"',
        '"passwordPlaceholder": "e.g. hunter2"',
        '"tokenExpired": "Token expired"',
        '"forgotPassword": "Forgot password?"',
        '"confirmPassword": "Confirm password"',
        '"password": "Passwort"',
      ].join("\n"),
    ],
    ["prose with bearer and basic", "Bearer of bad news. The bearer tokenization-strategies doc. Basic authentication-explained."],
    ["a URL with a port and no password", "http://localhost:8080/v1/chat ssh://git@github.com/o/r.git"],
    ["clock times and versions", "12:30:45 version: 1.2.3 key: value"],
  ])("leaves %s unchanged", (_name, text) => {
    expect(maskSecrets(text)).toBe(text);
  });

  it("leaves a base64 image untouched even when its alphabet spells a key prefix", () => {
    // `AIza…`/`AKIA…` inside base64 are preceded and followed by base64
    // characters, which the fixed-length shapes refuse.
    const image =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" +
      "CAYAAAAfFcSJ" + "AIza" + "SyA0123456789abcdefghijklmnopqrstu" + "AKIA" + "IOSFODNN7EXAMPLEKEYxyz" +
      "Q".repeat(4000) + "==";
    expect(maskSecrets(image)).toBe(image);
  });

  it("leaves pseudo-random base64 untouched", () => {
    const bytes = Buffer.from(Array.from({ length: 200_000 }, (_, i) => ((i * 2654435761) >>> 24) & 255));
    const blob = bytes.toString("base64");
    expect(maskSecrets(blob)).toBe(blob);
  });
});

describe("maskSecrets: properties", () => {
  it("is idempotent: a marker is never masked again", () => {
    const text = [
      `OPENROUTER_API_KEY=${OPENROUTER}`,
      "DB_PASSWORD=hunter2secret",
      "postgres://app:hunter2secret@db/x",
      "Authorization: Bearer abcDEF123456ghiJKL789xyz",
      `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----`,
    ].join("\n");
    const once = maskSecrets(text, [{ label: "X", value: "hunter2secret" }]);
    expect(maskSecrets(once, [{ label: "X", value: "hunter2secret" }])).toBe(once);
  });

  it("returns the same string when there is nothing to mask", () => {
    const text = "plain output\nexit: 0";
    expect(maskSecrets(text)).toBe(text);
  });

  it("stays linear on adversarial input", () => {
    const hostile =
      "a=".repeat(200_000) +
      "sk-".repeat(50_000) +
      "-----BEGIN PRIVATE KEY-----".repeat(5_000) +
      "eyJ".repeat(50_000) +
      "postgres://".repeat(20_000) +
      "@" +
      "Bearer ".repeat(20_000) +
      "password: ".repeat(20_000) +
      "x".repeat(500_000);
    const started = Date.now();
    maskSecrets(hostile);
    // About 0.2 s on a laptop; the bound only catches super-linear blowup.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
