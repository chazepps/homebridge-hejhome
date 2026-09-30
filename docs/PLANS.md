# Plans

## Build Plan

1. Maintain official Homebridge dynamic platform gates.
2. Keep login UI sequence locked by Playwright.
3. Expand Hejhome API client only from redacted packet evidence.
4. Add device capability mappings one device class at a time.
5. Publish through npm Trusted Publishing after CI is stable.

## Active Execution Plan

`docs/exec-plans/2026-09-30-2.1.0-beta.md` prepares the opt-in 2.1 beta without publication.


`docs/exec-plans/2026-05-28-production-hardening-and-device-expansion.md` tracks the current product hardening batch: public documentation cleanup, Trusted Publishing alignment, Pi runtime regression verification, and realtime/device-state normalization tests.

## Feature Expansion Action Checklist

[Homebridge 기능 확장 액션 체크리스트](exec-plans/2026-09-30-homebridge-feature-action-checklist.md)는 A1–A7, B1–B10, Smart Automation C0–C5, 범위 점검과 베타 출시 게이트를 추적합니다. 기능 구현 완료와 문서 작성 완료를 구분하며, 게시·운영 설치는 별도 명시 지시 전에는 실행하지 않습니다.

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
