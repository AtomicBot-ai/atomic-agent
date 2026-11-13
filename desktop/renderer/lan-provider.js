/* ATO-1066: a model on another computer on this network (a desktop with a big
   GPU running llama-server, LM Studio or Ollama with network serving on), used
   from this one as an OpenAI-compatible provider. One more row in the
   add-provider list: an address field and an optional key. The rules mirror
   the agent's src/llm/provider/openai/network-server-address.ts.
   Feature module: functions only; renderer.js adds the row and calls them. */

/** The add-provider row. `custom` gives it the address field and a URL-derived
    id; `lan` makes the key optional and picks the words below. */
function lanProviderRow() {
  return {id:'lan-computer', kind:'openai-compatible', label:'Another computer on your network', custom:true, lan:true};
}

/** What people type, read off the other computer — `192.168.1.20:8080`,
    `gpu-box.local:1234`, `http://10.0.0.5:11434/v1` — as the base URL the
    entry stores: a scheme (`http://` when none was typed), no query, no
    trailing slash, no `/v1` (the agent appends it). {ok, baseUrl} or {ok:false, reason}. */
function lanAddressToBaseUrl(raw) {
  const typed = String(raw == null ? '' : raw).trim();
  if (!typed) return {ok:false, reason:'Type the other computer’s address, for example 192.168.1.20:8080.'};
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : 'http://' + typed;
  let url;
  try { url = new URL(withScheme); } catch (err) { return {ok:false, reason:'That is not an address. Use the form 192.168.1.20:8080.'}; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return {ok:false, reason:'Use an http:// or https:// address.'};
  if (!url.hostname) return {ok:false, reason:'Type the other computer’s name or IP address.'};
  if (url.username || url.password) return {ok:false, reason:'Leave the password out of the address; put a key in the key field instead.'};
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return {ok:true, baseUrl: url.protocol + '//' + url.host + path};
}

/** agent-cli.ts isOtherComputerOnNetworkUrl: a private-network address that is not
    this machine (RFC 1918, link-local, unique-local, .local/.lan/.internal/.home.arpa
    or a single-label name). Such a server needs no key unless it says so. */
function lanIsOtherComputerUrl(url) {
  let host;
  try { host = new URL(String(url || '')).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''); } catch (err) { return false; }
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0') return false;
  const v4 = host.split('.');
  if (v4.length === 4 && v4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    const a = Number(v4[0]), b = Number(v4[1]);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (host.includes(':')) return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
  if (!host.includes('.')) return true;
  return ['.local', '.lan', '.internal', '.home.arpa'].some((suffix) => host.endsWith(suffix));
}

/** The line the wizard shows when the model list failed for this row, or
    null to keep the generic one. `unreachable`: nothing answered (the causes
    are all on the other computer); `refused` with no key typed: the server
    was started with a key. */
function lanWizardError(where, unreachable, refused, keyTyped) {
  if (unreachable) {
    return 'Nothing answered at ' + where + '. Check that the other computer is on, its model server is running and listening '
      + 'on the network (not only on 127.0.0.1), and its firewall lets this port in. Then try again.';
  }
  if (refused && !keyTyped) return 'The server at ' + where + ' asks for a key. Type the key it was started with, then try again.';
  return null;
}
