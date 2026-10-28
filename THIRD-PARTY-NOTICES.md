# Third-party notices

Atomic Agent is MIT licensed (see [LICENSE](LICENSE)). Some of its logic is derived from the projects below. The code in this repository is our own implementation; these notices credit the designs it follows and carry the upstream licence terms.

## opencode

- Used in: `src/tools/os/fs/fs-edit-tolerant.ts`, `src/tools/os/fs/fs-edit-folding.ts`, `src/tools/os/fs/fs-edit-block-anchor.ts` (the `os.fs.edit` tolerant match chain).
- Derived from: the replacer chain in `packages/opencode/src/tool/edit.ts` (`LineTrimmedReplacer`, `BlockAnchorReplacer`, `WhitespaceNormalizedReplacer`, `IndentationFlexibleReplacer`, `EscapeNormalizedReplacer`, `TrimmedBoundaryReplacer`), tag v1.19.1.
- Source: https://github.com/sst/opencode
- Licence: MIT

```
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## OpenAI Codex

- Used in: `src/tools/os/fs/fs-edit-folding.ts` (the typography level of the `os.fs.edit` match chain).
- Derived from: the Unicode punctuation folding (`normalise`) in `codex-rs/apply-patch/src/seek_sequence.rs`, commit 685270a.
- Source: https://github.com/openai/codex
- Licence: Apache License 2.0, https://www.apache.org/licenses/LICENSE-2.0
- Changes: reimplemented in TypeScript; the folding is applied to whole-file and line comparisons in `os.fs.edit` rather than to patch hunks.

Upstream NOTICE:

```
OpenAI Codex
Copyright 2025 OpenAI
```
