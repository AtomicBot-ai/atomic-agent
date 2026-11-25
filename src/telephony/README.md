# Telephony

Status: current (first slice, ATO-24)
Owner: src/telephony/

Phone calls through the user's own telephony account (decided 18.11.2026): the user brings the provider key and the caller number, we run no telephony account and pay for no calls. Twilio first.

Setup, in the environment or `<stateDir>/.env` (nothing goes into `config.json`):

```
TWILIO_ACCOUNT_SID=AC...        # from the Twilio console
TWILIO_AUTH_TOKEN=...           # the account's auth token
TWILIO_FROM_NUMBER=+14155550100 # a voice-capable number on that account, E.164
```

Any one missing means calls are off; [`readTelephonyConfig`](telephony-config.ts) says which variable is missing and never echoes a value.

What this slice has: [`TwilioVoiceClient`](twilio-voice-client.ts), plain REST over `fetch` (no SDK, no new dependency).

- `placeCall({ to, message, language? })` dials an E.164 number from the configured one and reads `message` aloud (TwiML `<Say>`, escaped so the text cannot add verbs such as `<Dial>`). At most 1000 characters, rings for 30 seconds.
- `getCall(sid)` reads a call's status and duration.
- A create is never retried: a retried POST could dial twice, and every call costs the user money.
- Errors never carry the auth token.

Not yet (next slices):

- An agent tool to place a call, with an approval on every call that shows the number and the exact words, the same gate as sending e-mail. No call is ever placed without it.
- Two-way calls (the agent listens and answers; Twilio Media Streams plus speech-to-text), a report of the call afterwards, inbound calls.
- Settings in the desktop app, other providers.

Tests: [telephony.test.ts](telephony.test.ts) (fake `fetch`, no network, no call is placed).
