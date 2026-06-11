# GAIA dataset (external)

The real GAIA benchmark lives on Hugging Face as a **gated** dataset:

- Repo: `gaia-benchmark/GAIA`
- Accept the license on the HF hub, then set `HF_TOKEN` (or `HUGGINGFACE_HUB_TOKEN`).

Download into this folder:

```bash
npm run eval:agents:datasets
```

Materialised layout:

```
datasets/gaia/hf/
  2023/validation/metadata.jsonl
  2023/validation/<attachment files>
```

Smoke tests use committed fixtures under `datasets/gaia/fixtures/` so the
harness runs without HF credentials. Full benchmark runs require the
download step above.
