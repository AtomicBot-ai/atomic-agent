/**
 * Tasks from the operator's own mailbox over IMAP (ATO-601). See README.md.
 */
export {
  ImapClient,
  ImapCommandError,
  connectImapTls,
  type ImapIdleOutcome,
  type ImapSelectResult,
  type ImapTransport,
} from "./imap-client.js";
export {
  ImapMailTrigger,
  activeImapBindings,
  type ImapConnect,
  type ImapMailTriggerOptions,
} from "./imap-mail-trigger.js";
