# Atomic Agent

A local-first AI agent for your terminal. It runs local models through llama.cpp (or a cloud provider you choose) and works with your files, shell and browser.

```sh
npm install -g atomic-agent
atag
```

`npx atomic-agent` runs it without installing.

The package installs the `atag` command (and `atomic-agent`, the same program). npm fetches one platform package with the prebuilt binary for your machine: macOS on Apple silicon, Linux x64 and arm64 (glibc 2.34 or newer), Windows x64.

Update with `npm install -g atomic-agent@latest`. `atag update` tells you the same, since npm owns this copy.

Other ways to install (the one-line installer, Homebrew, apt, dnf, the AUR, the desktop app): https://atomicagent.io

License: MIT. Source: https://github.com/AtomicBot-ai/atomic-agent
