# Plans

## Build Plan

1. Maintain official Homebridge dynamic platform gates.
2. Keep login UI sequence locked by Playwright.
3. Expand Hejhome API client only from redacted packet evidence.
4. Add device capability mappings one device class at a time.
5. Publish through npm Trusted Publishing after CI is stable.

## Active Execution Plan

The next maintenance releases are `2.1.2` on `latest` and `3.0.1-beta.1` on `beta`. They update the development-only TypeScript ESLint tools to 8.71.0. Runtime features and supported environments are unchanged. Current beta support and installation instructions are in [the 3.0 beta guide](product-specs/3.0-beta-guide.md).

## Feature Expansion Action Checklist

[Homebridge 기능 확장 액션 체크리스트](exec-plans/2026-09-30-homebridge-feature-action-checklist.md)는 A1–A7, B1–B10, Smart Automation C0–C5, 범위 점검과 베타 출시 게이트를 추적합니다. 기능 구현 완료와 문서 작성 완료를 구분하며, 게시·운영 설치는 별도 명시 지시 전에는 실행하지 않습니다.

Recent UI state, login recovery and automatic discovery review findings have been fixed and covered by regression tests. Publication and channel verification are complete; unfinished physical-device acceptance remains tracked separately in the checklist.

## Test Plan

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run test:ui`
- `npm run build`
- `npm run docs:check`
- `npm pack --dry-run`

## Release Plan

Tags must match package and lockfile versions. Numbered beta versions publish only to `beta`; stable versions require an explicit `latest` package configuration. Node 22/24/26 checks gate publication.
