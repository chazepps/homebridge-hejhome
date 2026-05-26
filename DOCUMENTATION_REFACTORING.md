# Documentation Refactoring

> Status: source-derived scaffold

This ledger tracks the documentation harness for the Hejhome Homebridge plugin. The shape follows the requested documentation information architecture, but all content is specific to this plugin.

## Priority

- [x] Create root architecture and documentation ledger.
- [x] Add design, frontend, product, reliability, security, quality, and plan documents.
- [x] Add generated project structure tooling.
- [x] Add forbidden content and sensitive value validation.
- [ ] Keep generated structure current after every source tree change.

## Validation Commands

```sh
node tools/docs/inventory-doc-harness.mjs --check
node tools/docs/validate-doc-harness.mjs
node tools/docs/generate-project-structure.mjs --check
git diff --check
```

## Documentation Rules

- Do not copy archived implementation text into new docs.
- Do not include raw credentials, raw cookies, raw tokens, raw authorization headers, or raw user identifiers.
- Treat `backup/` as reference material only.
- Treat `docs/generated/` as generated output.
- Update this file before claiming documentation work is complete.
