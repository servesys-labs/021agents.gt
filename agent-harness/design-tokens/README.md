# OpenShots Design Tokens

Centralized token source for web (`ui`) and mobile (`mobile`).

## Source of truth

- `design-tokens/tokens.json`

## Generated outputs

- `ui/src/generated/tokens.css` (CSS variables for Svelte web UI)
- `mobile/src/theme/tokens.ts` (typed React Native token object)

## Regenerate

From repo root:

```bash
node design-tokens/build-tokens.mjs
```

Or from `ui/`:

```bash
npm run tokens:build
```

## Notes

- Keep semantic token names stable (`background`, `foreground`, `primary`, etc.).
- Mobile output converts OKLCH to RN-safe color strings (`#RRGGBB`/`rgba(...)`).
- Edit only `tokens.json`; generated files are overwritten.
