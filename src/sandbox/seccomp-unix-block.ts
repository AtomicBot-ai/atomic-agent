/**
 * The seccomp filter for the Linux sandbox without network (ATO-2469).
 *
 * `--unshare-net` blocks abstract unix sockets only; a socket bound to a
 * file path (docker.sock, a user's own agent socket in some folder) stays
 * reachable. `os-sandbox-sockets.ts` covers the known places by path,
 * which can never be a complete list. This filter closes the class: a
 * sandboxed process cannot create an `AF_UNIX` socket that could reach a
 * socket file (`socket(AF_UNIX)` and a datagram `socketpair` are both
 * refused), wherever that file lives. Same
 * approach as Claude Code's sandbox-runtime on Linux (a BPF program that
 * refuses `socket(AF_UNIX, ...)`, applied by bubblewrap).
 *
 * The program is classic BPF, built here (no binary is shipped) and
 * handed to `bwrap --seccomp <fd>` on a pipe, never through a file a
 * sandboxed command could rewrite. bwrap sets `no_new_privs` and the
 * filter is inherited by every child, across exec, for good.
 *
 * What it refuses, with `EPERM` (the "Operation not permitted" the
 * sandbox notice already names):
 * - `socket(AF_UNIX, ...)` on x86_64, its x32 ABI, i386 and aarch64, and
 *   32-bit ARM (a 32-bit binary runs on a 64-bit host with its own
 *   syscall numbers, so each table is checked);
 * - `socketpair(AF_UNIX, ...)` of any type but `SOCK_STREAM` and
 *   `SOCK_SEQPACKET`: a datagram pair (`SOCK_DGRAM`, or `SOCK_RAW`,
 *   which unix sockets turn into one) can still `connect` or `sendto` a
 *   named datagram socket (journald's `/dev/log`, `NOTIFY_SOCKET`, one in
 *   the working folder; review F1933.1). A stream or seqpacket pair is
 *   connected for good (`EISCONN`), so it stays allowed: libuv, Python
 *   and most programs make their pairs that way;
 * - the i386 `socketcall(SYS_SOCKET, ...)` and `socketcall(SYS_SOCKETPAIR,
 *   ...)` multiplexer calls: their arguments sit behind a pointer the
 *   filter cannot read, so every socket and pair they would create is
 *   refused (old 32-bit binaries only; current glibc calls `socket` and
 *   `socketpair` directly);
 * - `io_uring_setup`: `IORING_OP_SOCKET` creates sockets without the
 *   `socket` syscall, past any seccomp filter (Docker's default profile
 *   blocks io_uring for the same reason). Programs fall back to epoll.
 *
 * Everything else is allowed. Hosts other than x64 and arm64 get no
 * filter (the path masks remain).
 */
import { endianness } from "node:os";

/** The child's fd that carries the program (`bwrap --seccomp 3`). */
export const SECCOMP_PROGRAM_FD = 3;

// BPF opcodes (linux/filter.h).
const LD_W_ABS = 0x20; // BPF_LD | BPF_W | BPF_ABS
const JEQ_K = 0x15; // BPF_JMP | BPF_JEQ | BPF_K
const AND_K = 0x54; // BPF_ALU | BPF_AND | BPF_K
const RET_K = 0x06; // BPF_RET | BPF_K

// linux/seccomp.h
const RET_ALLOW = 0x7fff0000;
const RET_ERRNO = 0x00050000;
const EPERM = 1;

// Offsets in `struct seccomp_data`: nr, arch, ip (u64), args[6] (u64).
// The low word of args[0] (little-endian) is the socket domain, that of
// args[1] the type (with SOCK_NONBLOCK and SOCK_CLOEXEC above bit 3).
const OFF_NR = 0;
const OFF_ARCH = 4;
const OFF_ARG0_LOW = 16;
const OFF_ARG1_LOW = 24;

/** linux/audit.h: EM_* with the 64-bit and little-endian flags. */
export const AUDIT_ARCH = {
  x86_64: 0xc000003e,
  aarch64: 0xc00000b7,
  i386: 0x40000003,
  arm: 0x40000028,
} as const;

const AF_UNIX = 1;
const SOCK_STREAM = 1;
const SOCK_SEQPACKET = 5;
const SOCK_TYPE_MASK = 0xf;
const SYS_SOCKET = 1; // socketcall's call numbers for socket()
const SYS_SOCKETPAIR = 8; // and socketpair()
const X32_BIT = 0x40000000;

/** Syscall numbers per table. */
export const SYSCALLS = {
  x86_64: { socket: 41, socketpair: 53, ioUringSetup: 425 },
  aarch64: { socket: 198, socketpair: 199, ioUringSetup: 425 },
  i386: { socket: 359, socketpair: 360, socketcall: 102, ioUringSetup: 425 },
  arm: { socket: 281, socketpair: 288, ioUringSetup: 425 },
} as const;

type Insn =
  | { label: string }
  | { op: "ld"; offset: number }
  | { op: "jeq"; k: number; to: string }
  | { op: "and"; k: number }
  | { op: "ret"; k: number };

const allow: Insn = { op: "ret", k: RET_ALLOW };

/** Load the syscall number, then jump on each listed one. */
function table(label: string, jumps: readonly [number, string][]): Insn[] {
  return [
    { label },
    { op: "ld", offset: OFF_NR },
    ...jumps.map(([k, to]): Insn => ({ op: "jeq", k, to })),
    allow,
  ];
}

const PROGRAM: readonly Insn[] = [
  { op: "ld", offset: OFF_ARCH },
  { op: "jeq", k: AUDIT_ARCH.x86_64, to: "x86_64" },
  { op: "jeq", k: AUDIT_ARCH.aarch64, to: "aarch64" },
  { op: "jeq", k: AUDIT_ARCH.i386, to: "i386" },
  { op: "jeq", k: AUDIT_ARCH.arm, to: "arm" },
  allow,
  ...table("x86_64", [
    [SYSCALLS.x86_64.socket, "domain"],
    [X32_BIT | SYSCALLS.x86_64.socket, "domain"],
    [SYSCALLS.x86_64.socketpair, "pair"],
    [X32_BIT | SYSCALLS.x86_64.socketpair, "pair"],
    [SYSCALLS.x86_64.ioUringSetup, "deny"],
    [X32_BIT | SYSCALLS.x86_64.ioUringSetup, "deny"],
  ]),
  ...table("aarch64", [
    [SYSCALLS.aarch64.socket, "domain"],
    [SYSCALLS.aarch64.socketpair, "pair"],
    [SYSCALLS.aarch64.ioUringSetup, "deny"],
  ]),
  ...table("i386", [
    [SYSCALLS.i386.socket, "domain"],
    [SYSCALLS.i386.socketpair, "pair"],
    [SYSCALLS.i386.socketcall, "socketcall"],
    [SYSCALLS.i386.ioUringSetup, "deny"],
  ]),
  ...table("arm", [
    [SYSCALLS.arm.socket, "domain"],
    [SYSCALLS.arm.socketpair, "pair"],
    [SYSCALLS.arm.ioUringSetup, "deny"],
  ]),
  { label: "socketcall" },
  { op: "ld", offset: OFF_ARG0_LOW },
  { op: "jeq", k: SYS_SOCKET, to: "deny" },
  { op: "jeq", k: SYS_SOCKETPAIR, to: "deny" },
  allow,
  { label: "domain" },
  { op: "ld", offset: OFF_ARG0_LOW },
  { op: "jeq", k: AF_UNIX, to: "deny" },
  allow,
  // socketpair: AF_UNIX pairs only as stream or seqpacket.
  { label: "pair" },
  { op: "ld", offset: OFF_ARG0_LOW },
  { op: "jeq", k: AF_UNIX, to: "pairType" },
  allow,
  { label: "pairType" },
  { op: "ld", offset: OFF_ARG1_LOW },
  { op: "and", k: SOCK_TYPE_MASK },
  { op: "jeq", k: SOCK_STREAM, to: "pairOk" },
  { op: "jeq", k: SOCK_SEQPACKET, to: "pairOk" },
  { op: "ret", k: RET_ERRNO | EPERM },
  { label: "pairOk" },
  allow,
  { label: "deny" },
  { op: "ret", k: RET_ERRNO | EPERM },
];

/** `struct sock_filter` entries (code u16, jt u8, jf u8, k u32), little-endian. */
export function assembleSeccompProgram(program: readonly Insn[] = PROGRAM): Buffer {
  const labels = new Map<string, number>();
  const insns: Exclude<Insn, { label: string }>[] = [];
  for (const insn of program) {
    if ("label" in insn) labels.set(insn.label, insns.length);
    else insns.push(insn);
  }
  const out = Buffer.alloc(insns.length * 8);
  insns.forEach((insn, i) => {
    let code: number;
    let jt = 0;
    let k: number;
    if (insn.op === "ld") {
      code = LD_W_ABS;
      k = insn.offset;
    } else if (insn.op === "ret") {
      code = RET_K;
      k = insn.k;
    } else if (insn.op === "and") {
      code = AND_K;
      k = insn.k;
    } else {
      code = JEQ_K;
      k = insn.k;
      const target = labels.get(insn.to);
      if (target === undefined || target <= i) {
        throw new Error(`seccomp program: bad jump to ${insn.to}`);
      }
      jt = target - (i + 1);
      if (jt > 255) throw new Error("seccomp program: jump too far");
    }
    const at = i * 8;
    out.writeUInt16LE(code, at);
    out.writeUInt8(jt, at + 2);
    out.writeUInt8(0, at + 3); // jf: fall through to the next one
    out.writeUInt32LE(k >>> 0, at + 4);
  });
  return out;
}

/**
 * The filter for this host, or null where none is built (a host other
 * than x64 or arm64, or a big-endian one): the caller then keeps only
 * the socket path masks.
 */
export function unixSocketBlockProgram(
  arch: string = process.arch,
  byteOrder: "LE" | "BE" = endianness(),
): Buffer | null {
  if (byteOrder !== "LE") return null;
  if (arch !== "x64" && arch !== "arm64") return null;
  return assembleSeccompProgram();
}
