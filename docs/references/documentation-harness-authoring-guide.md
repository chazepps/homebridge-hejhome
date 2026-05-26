# Documentation Harness Authoring Guide

## Principles

1. Start from current source and tests.
2. Keep generated snapshots generated.
3. Keep manual docs focused on architecture, product intent, security, and reliability.
4. Never commit raw secrets, raw account identifiers, raw cookies, or raw tokens.
5. Run the documentation gates before reporting completion.

## Standard Tree

```text
docs/
├── README.md
├── DESIGN.md
├── FRONTEND.md
├── PLANS.md
├── PRODUCT_SENSE.md
├── QUALITY_SCORE.md
├── RELIABILITY.md
├── SECURITY.md
├── design-docs/
├── exec-plans/
├── generated/
├── product-specs/
├── project-avatar/
└── references/
```

## Resume Protocol

Read `DOCUMENTATION_REFACTORING.md`, regenerate structure snapshots, update the smallest relevant manual docs, then run `npm run docs:check`.
