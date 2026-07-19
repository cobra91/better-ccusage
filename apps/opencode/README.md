<div align="center">
    <h1>@better-ccusage/opencode</h1>
</div>

> ⚠️ <strong>Deprecated.</strong> OpenCode support is now built directly into <a href="https://www.npmjs.com/package/better-ccusage"><code>better-ccusage</code></a> as the <code>opencode</code> source. This package now exists only as a thin forwarder for backward compatibility and will not receive new features.

## Migration

`@better-ccusage/opencode` has been merged into `better-ccusage`. Your OpenCode sessions (`~/.local/share/opencode/opencode.db`) are now read automatically alongside Claude, Droid, ZCode, and Codex data.

**Before:**

```bash
npx @better-ccusage/opencode@latest daily
```

**After:**

```bash
npx better-ccusage daily
```

The `better-ccusage` CLI exposes every command the standalone opencode tool had (`daily`, `monthly`, `weekly`, `session`) **plus** `blocks`, `statusline`, `--mode`, `--breakdown`, config-file support, and combined cross-tool reports.

## Backward compatibility

This package still works: every invocation is forwarded to `better-ccusage` with the original `OPENCODE_DATA_DIR` preserved. A one-line deprecation notice is printed to stderr (set `OPENCODE_NO_DEPRECATION_NOTICE=1` to silence it in CI).

```bash
# Still works — forwarded transparently
npx @better-ccusage/opencode daily --json
```

## Why the merge?

Maintaining a separate OpenCode CLI duplicated code that `better-ccusage` already offered (and did better). The upstream [`ccusage`](https://github.com/ccusage/ccusage) project had already consolidated OpenCode as a built-in source, and this merge aligns `better-ccusage` with that architecture.

This migration also fixes a latent bug: the old standalone opencode package read `msg_*.json` files that modern OpenCode no longer writes (it now uses a SQLite database, `opencode.db`). As a result the old package showed **zero data** for any recent OpenCode install. The new built-in source reads the SQLite database directly.

## License

MIT © [@cobra91](https://github.com/cobra91)
