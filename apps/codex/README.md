<div align="center">
    <h1>@better-ccusage/codex</h1>
</div>

> ⚠️ <strong>Deprecated.</strong> Codex support is now built directly into <a href="https://www.npmjs.com/package/better-ccusage"><code>better-ccusage</code></a> as the <code>codex</code> source. This package now exists only as a thin forwarder for backward compatibility and will not receive new features.

## Migration

`@better-ccusage/codex` has been merged into `better-ccusage`. Your Codex sessions (`~/.codex/sessions`) are now read automatically alongside Claude, Droid, and ZCode data.

**Before:**

```bash
npx @better-ccusage/codex@latest daily
```

**After:**

```bash
npx better-ccusage daily
```

The `better-ccusage` CLI exposes every command the standalone codex tool had (`daily`, `monthly`, `session`) **plus** `weekly`, `blocks`, `statusline`, `--mode`, `--breakdown`, config-file support, and combined cross-tool reports.

## Backward compatibility

This package still works: every invocation is forwarded to `better-ccusage` with the original `CODEX_HOME` preserved. A one-line deprecation notice is printed to stderr (set `CODEX_NO_DEPRECATION_NOTICE=1` to silence it in CI).

```bash
# Still works — forwarded transparently
npx @better-ccusage/codex daily --json
```

## Why the merge?

Maintaining a separate Codex CLI duplicated ~2,000 lines that `better-ccusage` already offered (and did better). The upstream [`ccusage`](https://github.com/ryoppippi/ccusage) project had already consolidated Codex as a built-in source, and this merge aligns `better-ccusage` with that architecture. For details, see the [Codex source guide](https://better-ccusage.com/guide/codex/).

## License

MIT © [@cobra91](https://github.com/cobra91)
