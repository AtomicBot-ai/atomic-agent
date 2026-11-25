// Network-egress tripwire for test children (ATO-1086).
//
// Loaded with `node --import <this file>` (or the same flag in NODE_OPTIONS,
// which also reaches every Node grandchild: MCP servers, workers, helpers).
// Any attempt to reach a host that is not this machine is
//   - written as one JSON line to $ATOMIC_AGENT_NET_INTERCEPT_LOG, and
//   - failed before a packet leaves (ECONNREFUSED / ENOTFOUND), so a test
//     never depends on the network and never leaks anything through it.
// Loopback (127.0.0.0/8, ::1, localhost, 0.0.0.0) and unix sockets / named
// pipes pass untouched: the local model server and the sidecar live there.
//
// Covered: every TCP and TLS connection (net.Socket#connect, which http,
// https, tls, undici/fetch and WebSocket clients all go through), UDP
// (dgram send/connect), and DNS (dns.lookup, dns.resolve*, their promise
// forms, dns.Resolver), because a lookup alone already tells the network a
// name. Not covered: a non-Node child process (curl, git, a browser); those
// need an OS-level sandbox and are out of scope here.
import { appendFileSync } from "node:fs";
import dgram from "node:dgram";
import dns from "node:dns";
import net from "node:net";

const LOG = process.env.ATOMIC_AGENT_NET_INTERCEPT_LOG || "";

/** True for this machine: loopback addresses and names, the unspecified address. */
export function isLocalHost(host) {
  if (host === undefined || host === null || host === "") return true; // Node's default is localhost
  const h = String(host).trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "::" || h === "0:0:0:0:0:0:0:1" || h === "0.0.0.0") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (mapped) return isLocalHost(mapped[1]);
  return false;
}

function record(kind, host, port) {
  const entry = { kind, host: String(host), port: port === undefined ? null : Number(port), pid: process.pid, at: new Date().toISOString() };
  if (LOG) {
    try {
      appendFileSync(LOG, JSON.stringify(entry) + "\n");
    } catch {
      // A missing log must not change what the program under test sees.
    }
  }
  return entry;
}

function refused(host, port) {
  const err = new Error(`connect ECONNREFUSED ${host}:${port ?? ""} (blocked by the test network tripwire)`);
  err.code = "ECONNREFUSED";
  err.errno = -61;
  err.syscall = "connect";
  err.address = String(host);
  if (port !== undefined) err.port = Number(port);
  return err;
}

function notFound(hostname) {
  const err = new Error(`getaddrinfo ENOTFOUND ${hostname} (blocked by the test network tripwire)`);
  err.code = "ENOTFOUND";
  err.errno = -3008;
  err.syscall = "getaddrinfo";
  err.hostname = String(hostname);
  return err;
}

/** `{ host, port, path }` from any of net.Socket#connect's call shapes. */
function connectTarget(args) {
  const first = args[0];
  if (Array.isArray(first)) return connectTarget(first); // internal normalized form
  if (first && typeof first === "object") return { host: first.host, port: first.port, path: first.path };
  if (typeof first === "string" && !/^\d+$/.test(first)) return { path: first };
  return { port: first, host: typeof args[1] === "string" ? args[1] : undefined };
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const target = connectTarget(args);
  if (target.path === undefined && !isLocalHost(target.host)) {
    record("tcp", target.host, target.port);
    const err = refused(target.host, target.port);
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return originalConnect.apply(this, args);
};

const originalSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function send(msg, ...rest) {
  // send(msg, [offset, length,] port, address, cb) with the address as the
  // last string argument; a connected socket omits port and address.
  const address = rest.find((value) => typeof value === "string");
  const port = rest.find((value) => typeof value === "number" && value > 0 && value < 65536);
  if (address !== undefined && !isLocalHost(address)) {
    record("udp", address, port);
    const cb = rest.find((value) => typeof value === "function");
    if (cb) process.nextTick(cb, refused(address, port));
    return;
  }
  return originalSend.call(this, msg, ...rest);
};

const originalUdpConnect = dgram.Socket.prototype.connect;
dgram.Socket.prototype.connect = function connect(port, address, cb) {
  const host = typeof address === "string" ? address : undefined;
  if (host !== undefined && !isLocalHost(host)) {
    record("udp", host, port);
    process.nextTick(() => this.emit("error", refused(host, port)));
    return;
  }
  return originalUdpConnect.call(this, port, address, cb);
};

function wrapCallbackLookup(owner, name, kind) {
  const original = owner[name];
  if (typeof original !== "function") return;
  owner[name] = function patched(hostname, ...rest) {
    if (!isLocalHost(hostname)) {
      record(kind, hostname);
      const cb = rest.findLast((value) => typeof value === "function");
      if (cb) process.nextTick(cb, notFound(hostname));
      return {};
    }
    return original.call(this, hostname, ...rest);
  };
}

function wrapPromiseLookup(owner, name, kind) {
  const original = owner?.[name];
  if (typeof original !== "function") return;
  owner[name] = function patched(hostname, ...rest) {
    if (!isLocalHost(hostname)) {
      record(kind, hostname);
      return Promise.reject(notFound(hostname));
    }
    return original.call(this, hostname, ...rest);
  };
}

const RESOLVE_NAMES = ["resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveMx", "resolveNs", "resolveTxt", "resolveSrv", "resolveCaa", "resolveNaptr", "resolvePtr", "resolveSoa"];

wrapCallbackLookup(dns, "lookup", "dns");
for (const name of RESOLVE_NAMES) wrapCallbackLookup(dns, name, "dns");
wrapPromiseLookup(dns.promises, "lookup", "dns");
for (const name of RESOLVE_NAMES) wrapPromiseLookup(dns.promises, name, "dns");
for (const name of RESOLVE_NAMES) {
  wrapCallbackLookup(dns.Resolver.prototype, name, "dns");
  wrapPromiseLookup(dns.promises.Resolver?.prototype, name, "dns");
}
