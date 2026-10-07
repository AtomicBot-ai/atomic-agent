# Remove existing Git tool descriptor duplicates

Status: proposed
Owner: src/prompt/ + src/tools/os/git/

Stage05l found 88 DEFAULT_TOOL_DESCRIPTORS entries for 85 names. os.git.checkout occurs at zero-based positions31/48, commit32/47 and push33/43. These copies predate the reorganization. [The conformance test](../../src/tools/tool-contract-conformance.test.ts) freezes complete ordered fingerprints and positions with owner/reason; changed, removed, third or newly duplicated entries fail.

Removing entries during a mechanical move would change behavior: both copies contribute stable-prefix bytes; getToolDescriptorByName selects the last copy while native wire deduplication selects the first. Checkout argument order differs, and push/checkout tiers differ. Choosing one copy changes discovery and full-description availability as well as prompt length. Preserved compatibility does not establish a correct catalog.

A separate change should select one descriptor from actual Git parser/schema/approval semantics, remove the second copies and retire the exact ledger entries together. Verify plain/strict native wire, tool.view under all roles, rare-tool loading, grammar offered names, Git arguments and approval. Record the expected stable-prefix byte change and one-time cache invalidation; do not merely regenerate golden outputs. Require 85 unique entries with no duplicate ledger afterward. Do not infer Git policy from readonly or change Git execution incidentally.

This is explicit behavioral debt outside mechanical05l acceptance. Other families' canonical ownership can expand separately: the current global gate proves presence/format for them, rather than semantic equality of every representation. [Stage05 acceptance](../testing/stage-05-validation.md) records that limit.
