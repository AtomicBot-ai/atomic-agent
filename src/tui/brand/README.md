# Brand badges

Status: current
Owner: src/tui/brand/

The terminal's stand-in for the desktop's logos (ATO-1635): one or two letters on the vendor's brand colour, always the same width, so a list of providers, models, integrations, MCP servers or import sources keeps one label column.

- [brand-badges.ts](brand-badges.ts) is the table (id to letters and colour) and the lookups: provider ids, model families, integration ids, MCP catalog ids, import sources. The model-family order mirrors the desktop's `modelLogoKey` in `desktop/renderer/renderer.js`, so both apps put the same brand on a model.
- [brand-badge.tsx](brand-badge.tsx) draws one badge as a nested Ink `Text`. Ink lowers the colour to what the terminal can show and drops it under `NO_COLOR`; the letters stay.

Rules: a brand with no confident entry gets a blank of the badge's width, never a made-up monogram (a custom endpoint or a user's own MCP server must not look like a vendor's). No Nerd Font glyphs. Real logo images are not drawn here: the CLI ships no raster logo files, and kitty's inline images stay limited to tool-card output.
