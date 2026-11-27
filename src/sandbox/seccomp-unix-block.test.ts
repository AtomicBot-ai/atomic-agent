import { describe, expect, it } from "vitest";

import {
  assembleSeccompProgram,
  AUDIT_ARCH,
  SYSCALLS,
  unixSocketBlockProgram,
} from "./seccomp-unix-block.js";

/**
 * ATO-2469: the program is run here through a small classic-BPF
 * interpreter over a `struct seccomp_data`, the way the kernel runs it,
 * so each verdict is checked as behaviour, not as bytes.
 */

const ALLOW = 0x7fff0000;
const EPERM = 0x00050001;

function run(program: Buffer, nr: number, arch: number, arg0: bigint = 0n, arg1: bigint = 0n): number {
  const data = Buffer.alloc(64);
  data.writeUInt32LE(nr >>> 0, 0);
  data.writeUInt32LE(arch >>> 0, 4);
  data.writeBigUInt64LE(arg0, 16);
  data.writeBigUInt64LE(arg1, 24);
  let acc = 0;
  for (let pc = 0; pc * 8 < program.length; pc += 1) {
    const code = program.readUInt16LE(pc * 8);
    const jt = program.readUInt8(pc * 8 + 2);
    const jf = program.readUInt8(pc * 8 + 3);
    const k = program.readUInt32LE(pc * 8 + 4);
    if (code === 0x20) acc = data.readUInt32LE(k);
    else if (code === 0x54) acc = (acc & k) >>> 0;
    else if (code === 0x15) pc += acc === k ? jt : jf;
    else if (code === 0x06) return k;
    else throw new Error(`unexpected opcode ${code}`);
  }
  throw new Error("program fell off the end");
}

const AF_UNIX = 1n;
const AF_INET = 2n;
const SOCK_STREAM = 1n;
const SOCK_DGRAM = 2n;
const SOCK_RAW = 3n;
const SOCK_SEQPACKET = 5n;
const SOCK_FLAGS = 0x80000n | 0x800n; // SOCK_CLOEXEC | SOCK_NONBLOCK
const program = assembleSeccompProgram();

describe("seccomp program that refuses AF_UNIX sockets (ATO-2469)", () => {
  it("refuses socket(AF_UNIX) on every syscall table of an x64 or arm64 host", () => {
    expect(run(program, SYSCALLS.x86_64.socket, AUDIT_ARCH.x86_64, AF_UNIX)).toBe(EPERM);
    expect(run(program, 0x40000000 | SYSCALLS.x86_64.socket, AUDIT_ARCH.x86_64, AF_UNIX)).toBe(EPERM);
    expect(run(program, SYSCALLS.aarch64.socket, AUDIT_ARCH.aarch64, AF_UNIX)).toBe(EPERM);
    expect(run(program, SYSCALLS.i386.socket, AUDIT_ARCH.i386, AF_UNIX)).toBe(EPERM);
    expect(run(program, SYSCALLS.arm.socket, AUDIT_ARCH.arm, AF_UNIX)).toBe(EPERM);
  });

  it("reads only the low word of the domain, as the kernel does for an int", () => {
    const dirty = (0xdeadbeefn << 32n) | AF_UNIX;
    expect(run(program, SYSCALLS.x86_64.socket, AUDIT_ARCH.x86_64, dirty)).toBe(EPERM);
  });

  it("allows other socket families (loopback inside the sandbox keeps working)", () => {
    expect(run(program, SYSCALLS.x86_64.socket, AUDIT_ARCH.x86_64, AF_INET)).toBe(ALLOW);
    expect(run(program, SYSCALLS.aarch64.socket, AUDIT_ARCH.aarch64, AF_INET)).toBe(ALLOW);
  });

  it("refuses io_uring, which creates sockets past the socket syscall", () => {
    expect(run(program, SYSCALLS.x86_64.ioUringSetup, AUDIT_ARCH.x86_64)).toBe(EPERM);
    expect(run(program, SYSCALLS.aarch64.ioUringSetup, AUDIT_ARCH.aarch64)).toBe(EPERM);
    expect(run(program, SYSCALLS.i386.ioUringSetup, AUDIT_ARCH.i386)).toBe(EPERM);
  });

  it("refuses the i386 socketcall(SYS_SOCKET) multiplexer, whose domain it cannot see", () => {
    expect(run(program, SYSCALLS.i386.socketcall, AUDIT_ARCH.i386, 1n)).toBe(EPERM);
    // SYS_CONNECT (3) on a socket made some other way is left alone.
    expect(run(program, SYSCALLS.i386.socketcall, AUDIT_ARCH.i386, 3n)).toBe(ALLOW);
  });

  it("refuses a datagram socketpair(AF_UNIX), which can sendto a named socket (review F1933.1)", () => {
    const tables: [number, number][] = [
      [SYSCALLS.x86_64.socketpair, AUDIT_ARCH.x86_64],
      [0x40000000 | SYSCALLS.x86_64.socketpair, AUDIT_ARCH.x86_64],
      [SYSCALLS.aarch64.socketpair, AUDIT_ARCH.aarch64],
      [SYSCALLS.i386.socketpair, AUDIT_ARCH.i386],
      [SYSCALLS.arm.socketpair, AUDIT_ARCH.arm],
    ];
    for (const [nr, arch] of tables) {
      expect(run(program, nr, arch, AF_UNIX, SOCK_DGRAM), `${nr}`).toBe(EPERM);
      expect(run(program, nr, arch, AF_UNIX, SOCK_DGRAM | SOCK_FLAGS), `${nr}`).toBe(EPERM);
      // Unix sockets turn SOCK_RAW into SOCK_DGRAM.
      expect(run(program, nr, arch, AF_UNIX, SOCK_RAW), `${nr}`).toBe(EPERM);
      // Stream and seqpacket pairs are connected for good: allowed.
      expect(run(program, nr, arch, AF_UNIX, SOCK_STREAM), `${nr}`).toBe(ALLOW);
      expect(run(program, nr, arch, AF_UNIX, SOCK_STREAM | SOCK_FLAGS), `${nr}`).toBe(ALLOW);
      expect(run(program, nr, arch, AF_UNIX, SOCK_SEQPACKET), `${nr}`).toBe(ALLOW);
      expect(run(program, nr, arch, AF_INET, SOCK_DGRAM), `${nr}`).toBe(ALLOW);
    }
    // The i386 multiplexer's SYS_SOCKETPAIR (8): its arguments are behind a pointer.
    expect(run(program, SYSCALLS.i386.socketcall, AUDIT_ARCH.i386, 8n)).toBe(EPERM);
  });

  it("allows everything else", () => {
    expect(run(program, 0, AUDIT_ARCH.x86_64)).toBe(ALLOW);
    // The numbers are per table: 198 on x86_64 is `lremovexattr`, not `socket`.
    expect(run(program, SYSCALLS.aarch64.socket, AUDIT_ARCH.x86_64, AF_UNIX)).toBe(ALLOW);
  });

  it("is built for x64 and arm64 little-endian hosts only", () => {
    expect(unixSocketBlockProgram("x64", "LE")?.equals(program)).toBe(true);
    expect(unixSocketBlockProgram("arm64", "LE")?.equals(program)).toBe(true);
    expect(unixSocketBlockProgram("riscv64", "LE")).toBeNull();
    expect(unixSocketBlockProgram("s390x", "BE")).toBeNull();
  });
});
