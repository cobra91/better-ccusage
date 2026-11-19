# Antigravity Source

better-ccusage reads [Antigravity](https://antigravity.google) usage directly from its local conversation databases — no API keys, no network calls.

## Usage

```bash
# All sources (Antigravity auto-detected)
better-ccusage daily

# Antigravity only
better-ccusage antigravity daily
```

## Data Location

By default, better-ccusage scans every Antigravity installation root for a `conversations/` directory:

- `~/.gemini/antigravity/conversations/`
- `~/.gemini/antigravity-cli/conversations/`
- `~/.gemini/antigravity-ide/conversations/`
- `~/.gemini/antigravity-backup/conversations/`
- `~/.gemini/antigravity-acp/conversations/`
- `~/.config/antigravity/conversations/`

Each conversation is a SQLite database whose `gen_metadata` and `steps` rows embed protobuf blobs with the per-request usage (input, output, cache read/creation, reasoning tokens), the model, and timestamps. better-ccusage decodes the protobuf wire format in place (read-only) — the wire schema mirrors upstream ccusage's reverse-engineered `rust/adapters/antigravity`.

## Token semantics

- Antigravity's `input_tokens` counter is **fresh input**: the cached shares live in their own `cache_read` / `cache_creation` counters and are billed at their own rates.
- The **total output** counter includes reasoning tokens; reasoning is billed at the output rate.
- Duplicate reports (same message/response id across retries or databases) are merged into a single billable event — the max of every counter wins.
- Numeric model ids map to canonical names (`gemini-3.8-flash-high`, `claude-opus-4-6`, …); unknown ids surface as `model_placeholder_m<N>` (ids ≥ 1000) or `antigravity-model-<id>` (smaller unmapped ids). Gemini effort variants (`-high`/`-medium`/`-low`/`-tiered`) share their base flash model's pricing.

## Environment Variable

```bash
ANTIGRAVITY_DATA_DIR=/path/to/antigravity better-ccusage daily
```

`ANTIGRAVITY_DATA_DIR` accepts a comma-separated list of roots. A root containing a `conversations/` subdirectory uses it; otherwise the root itself is scanned. When set, the default home roots are skipped.
