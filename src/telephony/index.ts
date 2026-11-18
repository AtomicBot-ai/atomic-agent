export {
  TWILIO_ENV,
  normalizePhoneNumber,
  readTelephonyConfig,
  type TelephonyConfigResult,
  type TwilioConfig,
} from "./telephony-config.js";
export {
  MAX_SPOKEN_CHARS,
  RING_TIMEOUT_S,
  TWILIO_API_BASE,
  TelephonyError,
  TwilioVoiceClient,
  escapeXml,
  spokenMessageTwiml,
  type CallRecord,
  type CallStatus,
  type FetchLike,
  type PlaceCallInput,
} from "./twilio-voice-client.js";
