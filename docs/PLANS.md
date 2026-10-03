# Plans

## Build Plan

1. Maintain official Homebridge dynamic platform gates.
2. Keep login UI sequence locked by Playwright.
3. Expand Hejhome API client only from redacted packet evidence.
4. Add device capability mappings one device class at a time.
5. Publish through npm Trusted Publishing after CI is stable.

## Active Execution Plan

[Homebridge 조직 스코프 이전 실행 계획](exec-plans/2026-10-03-homebridge-scope-migration.md)을 진행한다. 현재는 사전 점검과 [공식 신청 초안](exec-plans/2026-10-03-homebridge-scope-transfer-request.md) 작성 단계이며, 외부 신청과 소유권 이전은 아직 실행하지 않았다. v2 정식·v3 베타 채널, 기존 로그인·액세서리·페어링을 보존하는 것이 완료 기준이다.

Published maintenance releases: [2.1.2](https://github.com/chazepps/homebridge-hejhome/releases/tag/v2.1.2) on `latest` and [3.0.1-beta.1](https://github.com/chazepps/homebridge-hejhome/releases/tag/v3.0.1-beta.1) on `beta`. Both update the development-only TypeScript ESLint tools to 8.71.0. Runtime features and supported environments are unchanged. Published packages match the tested files, include provenance, and appear in Homebridge's version picker. GitHub Latest remains the v2 stable release. Current beta support and installation instructions are in [the 3.0 beta guide](product-specs/3.0-beta-guide.md).

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
