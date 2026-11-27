/**
 * ATO-2483: the mDNS responder that tells other computers of this network
 * about our shared model (packets in lan-mdns-announce.ts). Runs only while
 * the model is shared on the network (Settings › Models › Share this model,
 * "Local network"); this computer only, or off, announces nothing.
 *
 * One UDP socket on 5353 joined to 224.0.0.251 on each private interface,
 * shared with the system's own responder (mDNSResponder, Avahi, Windows'
 * mDNS) through SO_REUSEADDR / SO_REUSEPORT, as the `multicast-dns` and
 * `bonjour-service` packages do. It answers queries for our service, sends
 * two unsolicited announcements when it starts or the port changes (RFC
 * 6762 §8.3) and a goodbye (TTL 0) when it stops. A socket that cannot bind
 * leaves sharing working: other devices then type the address.
 */

import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { hostname, networkInterfaces } from "node:os";

import {
  buildServicesResponse,
  buildShareResponse,
  instanceLabel,
  matchShareQuery,
  type ShareAnnouncement,
} from "./lan-mdns-announce.js";
import { isPrivateV4, subnetsFromInterfaces, type IfaceAddr } from "./lan-discovery.js";
import { MDNS_ADDRESS, MDNS_PORT, parseMdnsQuestions } from "./lan-mdns.js";

export interface ShareAnnouncer {
  /** Announce the shared model on `port`, or stop announcing (`null`). */
  set: (port: number | null) => void;
  /** Same as `set(null)`, for app quit. */
  stop: () => void;
  /** Whether a socket is up and announcing now (tests, Diagnostics). */
  active: () => boolean;
}

export interface ShareAnnouncerDeps {
  createSocket?: () => Socket;
  interfaces?: () => Record<string, IfaceAddr[] | undefined>;
  hostname?: () => string;
  say?: (line: string) => void;
}

/** `a.b.c.d` as a 32-bit number, or null. */
function v4Number(ip: string): number | null {
  const parts = ip.replace(/^::ffff:/i, "").split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    n = n * 256 + Number(part);
  }
  return n;
}

/**
 * Whether `source` is on one of this computer's own private IPv4 networks
 * (its address and netmask), or this computer itself. RFC 6762 §11: a
 * responder answers only queries from its own link, so a host elsewhere
 * (or a forged source) gets nothing: no hostname, port or addresses, and
 * no bigger packet reflected at someone else.
 */
export function isOnLink(source: string, ifaces: Record<string, IfaceAddr[] | undefined>): boolean {
  const src = v4Number(source);
  if (src === null) return false;
  if (src >>> 24 === 127) return true;
  for (const list of Object.values(ifaces ?? {})) {
    for (const ad of list ?? []) {
      if (!ad || ad.internal || !(ad.family === "IPv4" || ad.family === 4) || !isPrivateV4(ad.address)) continue;
      const ip = v4Number(ad.address);
      const mask = v4Number(ad.netmask);
      if (ip === null || mask === null || mask === 0) continue;
      if (((ip & mask) >>> 0) === ((src & mask) >>> 0)) return true;
    }
  }
  return false;
}

/** Our private IPv4 addresses, the same networks "Find on my network" looks through. */
export function shareAddresses(ifaces: Record<string, IfaceAddr[] | undefined>): string[] {
  return subnetsFromInterfaces(ifaces).map((s) => s.self).filter(isPrivateV4);
}

export function createShareAnnouncer(deps: ShareAnnouncerDeps = {}): ShareAnnouncer {
  const makeSocket = deps.createSocket ?? (() => createSocket({ type: "udp4", reuseAddr: true }));
  const ifaces = deps.interfaces ?? (() => networkInterfaces() as Record<string, IfaceAddr[] | undefined>);
  const host = instanceLabel((deps.hostname ?? hostname)());
  const say = deps.say ?? ((line: string) => console.error(line));

  let sock: Socket | null = null;
  /** Sending on a socket before its bind finishes would bind it to a random port, so nothing is sent until then. */
  let bound = false;
  let current: ShareAnnouncement | null = null;
  let repeat: ReturnType<typeof setTimeout> | null = null;

  const announcement = (port: number): ShareAnnouncement => ({ instance: host, host, port, addresses: shareAddresses(ifaces()) });

  const multicast = (packet: Buffer): void => {
    if (!sock || !bound) return;
    try {
      sock.send(packet, MDNS_PORT, MDNS_ADDRESS);
    } catch {
      /* the interface went away; the next query or announcement tries again */
    }
  };

  const onMessage = (msg: Buffer, rinfo: RemoteInfo): void => {
    if (!current) return;
    // Only our own networks get an answer, by multicast or unicast alike.
    if (!isOnLink(rinfo.address, ifaces())) return;
    const questions = parseMdnsQuestions(msg);
    const match = matchShareQuery(questions, current);
    if (!match) return;
    // A one-shot query from another port (ours, `dns-sd -q`) gets a unicast reply with its id (RFC 6762 §6.7).
    const legacy = rinfo.port !== MDNS_PORT;
    const id = legacy ? msg.readUInt16BE(0) : 0;
    const packet = match === "share" ? buildShareResponse(current, { id }) : buildServicesResponse({ id });
    if (legacy || questions.some((q) => q.unicast)) {
      try {
        sock?.send(packet, rinfo.port, rinfo.address);
      } catch {
        /* the asker is gone */
      }
      return;
    }
    multicast(packet);
  };

  /** Close the socket; with `goodbye`, after that packet went out (a close right after a send can drop it). */
  const close = (goodbye?: Buffer): void => {
    if (repeat) clearTimeout(repeat);
    repeat = null;
    const was = sock;
    const wasBound = bound;
    sock = null;
    bound = false;
    if (!was) return;
    const end = () => {
      try {
        was.close();
      } catch {
        /* closed already */
      }
    };
    if (!goodbye || !wasBound) return end();
    try {
      was.send(goodbye, MDNS_PORT, MDNS_ADDRESS, () => end());
    } catch {
      end();
    }
  };

  const open = (): void => {
    let made: Socket;
    try {
      made = makeSocket();
    } catch {
      say("[desktop] model share: no UDP here, the shared model is not announced on the network");
      return;
    }
    sock = made;
    made.on("error", () => {
      say("[desktop] model share: the network announcement stopped (port 5353 is not available)");
      if (sock === made) close();
    });
    made.on("message", onMessage);
    made.bind(MDNS_PORT, () => {
      if (sock !== made) return;
      bound = true;
      try {
        made.setMulticastTTL(255);
      } catch {
        /* default TTL */
      }
      for (const address of current?.addresses ?? []) {
        try {
          made.addMembership(MDNS_ADDRESS, address);
        } catch {
          /* joined already, or this interface has no multicast */
        }
      }
      announce();
    });
  };

  const announce = (): void => {
    if (!current) return;
    const packet = buildShareResponse(current);
    multicast(packet);
    if (repeat) clearTimeout(repeat);
    repeat = setTimeout(() => {
      repeat = null;
      multicast(packet);
    }, 1000);
    repeat.unref?.();
  };

  const set = (port: number | null): void => {
    if (port === null) {
      const goodbye = current ? buildShareResponse(current, { ttl: 0 }) : undefined;
      current = null;
      close(goodbye);
      return;
    }
    const next = announcement(port);
    const sameAddresses = current !== null && current.addresses.join(",") === next.addresses.join(",");
    if (sameAddresses && current?.port === next.port && sock) return;
    const goodbye = current ? buildShareResponse(current, { ttl: 0 }) : undefined;
    current = next;
    if (!next.addresses.length) {
      close(goodbye);
      return;
    }
    // A new port is announced on the same socket; new addresses need their memberships, so a new socket.
    if (sock && sameAddresses) {
      if (goodbye) multicast(goodbye);
      announce();
    } else {
      close(goodbye);
      open();
    }
  };

  return { set, stop: () => set(null), active: () => sock !== null && current !== null };
}
