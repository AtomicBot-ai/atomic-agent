import { isLoopbackUrlOnPort } from "../local-llm/server/managed-api-key.js";

/**
 * llama-server's own default port since llama.cpp v0.7.0
 * (ggml-org/llama.cpp#30159), and the one it used before. The official
 * Docker images still listen on 8080 inside the container.
 */
const LLAMA_SERVER_PORTS = [9931, 8080] as const;

/**
 * One extra line for an unreachable External llama.cpp on this machine at
 * either default port. Older installs carry 8080 in config.json while a
 * fresh `llama-server` listens on 9931 (and the reverse for a Docker
 * image), so "nothing answered" on one of them most often means the
 * server is on the other. Null for any other host or port: there the
 * operator typed the port on purpose.
 */
export function llamaDefaultPortNote(url: string): string | null {
  if (!isLoopbackUrlOnPort(url, LLAMA_SERVER_PORTS)) return null;
  return (
    "A current llama-server listens on port 9931 by default. " +
    "Older builds and the Docker images use 8080."
  );
}

/**
 * One line for a loopback address on 8080, llama.cpp's old default, when
 * something there answered but it is not a working llama-server (ATO-708,
 * ATO-873). Configs written before the default moved keep 8080 while a
 * fresh `llama-server` listens on 9931, and the 8080 port is then often
 * held by an unrelated program that answers 404. The agent never rewrites
 * the address itself: this only says where to look. Null for any other
 * host or port.
 */
export function llamaLegacyPortNote(url: string): string | null {
  if (!isLoopbackUrlOnPort(url, [8080])) return null;
  return (
    "This address uses port 8080, llama.cpp's old default. " +
    "A current llama-server listens on 9931: if yours does, change the address to port 9931."
  );
}
