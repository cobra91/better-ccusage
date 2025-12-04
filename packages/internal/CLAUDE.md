# CLAUDE.md - Internal Package

This package contains shared internal utilities for the better-ccusage monorepo.

## Package Overview

**Name**: `@better-ccusage/internal`
**Description**: Shared internal utilities for better-ccusage toolchain
**Type**: Internal library (private package)

## Important Notes

**CRITICAL**: This is an internal package that gets bundled into the final applications. Therefore:

- **Always add this package as a `devDependency`** in apps that use it, NOT as a regular dependency
- Apps in this monorepo (better-ccusage, mcp, codex) are bundled CLIs, so all their runtime dependencies should be in `devDependencies`
- The bundler will include the code from this package in the final output

## Available Exports

**Utilities:**

- `./pricing` - Pricing fetcher and utilities
- `./pricing-fetch-utils` - Pricing fetch helper functions
- `./logger` - Logger factory using consola with LOG_LEVEL support
- `./format` - Number formatting utilities (formatTokens, formatCurrency)
- `./constants` - Shared constants (DEFAULT_LOCALE, MILLION)

## Development Commands

- `pnpm run test` - Run tests
- `pnpm run lint` - Lint code
- `pnpm run format` - Format and auto-fix code
- `pnpm typecheck` - Type check with TypeScript

## Adding New Utilities

When adding new shared utilities:

1. Create the utility file in `src/`
2. Add the export to `package.json` exports field
3. Import in consuming apps as `devDependencies`:
   <!-- eslint-skip -->
   ```json
   "devDependencies": {
     "@better-ccusage/internal": "workspace:*"
   }
   ```
4. Use the utility:
   ```typescript
   import { createLogger } from '@better-ccusage/internal/logger';
   ```

## Dependencies

This package has minimal runtime dependencies that get bundled:

- `@praha/byethrow` - Functional error handling
- `consola` - Logging
- `valibot` - Schema validation

## Pricing Implementation Notes

### Tiered Pricing Support

The pricing data supports tiered pricing for large context window models. Not all models use tiered pricing:

**Models WITH tiered pricing:**

- **Claude/Anthropic models**: 200k token threshold
  - Fields: `input_cost_per_token_above_200k_tokens`, `output_cost_per_token_above_200k_tokens`
  - Cache fields: `cache_creation_input_token_cost_above_200k_tokens`, `cache_read_input_token_cost_above_200k_tokens`
  - ✅ Currently implemented in cost calculation logic

- **Gemini models**: 128k token threshold
  - Fields: `input_cost_per_token_above_128k_tokens`, `output_cost_per_token_above_128k_tokens`
  - ⚠️ Schema supports these fields but calculation logic NOT implemented
  - Would require different threshold handling if Gemini support is added

**Models WITHOUT tiered pricing:**

- **GPT/OpenAI models**: Flat rate pricing (no token-based tiers)
  - Note: OpenAI has "tier levels" but these are for API rate limits, not pricing

### Automatic Model Detection

**No Manual Provider Prefix Management Required**

The `PricingFetcher` automatically detects and resolves model names with intelligent fallback matching:

1. **Exact Match**: Direct lookup for the model name as provided
2. **Provider Prefix Match**: Suffix matching for qualified names (e.g., `"moonshot/kimi-for-coding"` ends with `"/kimi-for-coding"`)
3. **Fuzzy Match**: Scored partial matching based on substring inclusion and provider priority

**Benefits**:
- Zero maintenance when adding new AI providers or models
- Models work with or without provider prefixes
- No `$0.00` costs from unfound models
- Automatic support for any provider naming pattern

**How It Works**:
- When resolving `"kimi-for-coding"`, the system checks:
  1. Direct match: `"kimi-for-coding"` in pricing data
  2. Suffix match: Any key ending with `"/kimi-for-coding"` (e.g., `"moonshot/kimi-for-coding"`)
  3. Fuzzy match: Keys containing `"kimi-for-coding"` with scoring

This eliminates the need for provider prefix whitelists that previously required manual updates.

### ⚠️ IMPORTANT for Future Development

When adding new models to the pricing database:

1. **Add to pricing JSON**: Update `packages/internal/model_prices_and_context_window.json`
2. **Check for tiered pricing**: Verify if model uses token threshold pricing (200k+ context)
3. **Verify threshold value**: 200k for Claude, 128k for Gemini, may vary for other providers
4. **Test model resolution**: Verify both `"model-name"` and `"provider/model-name"` work
5. **Add tests**: Include model resolution tests in pricing test suite
6. **Update docs**: Document any unique pricing characteristics

**Note**: No code changes needed for new providers - the automatic detection handles it!

The current `calculateTieredCost` implementation handles 200k thresholds. Adding models with different thresholds would require extending the tiered pricing logic.

## Code Style

Follow the same conventions as the main better-ccusage package:

- Use `.ts` extensions for local imports
- Prefer `@praha/byethrow Result` type over try-catch
- Only export what's actually used by other modules
- Use vitest in-source testing with `if (import.meta.vitest != null)` blocks
