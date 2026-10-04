# Plans

## Build Plan

1. Maintain official Homebridge dynamic platform gates.
2. Keep login UI sequence locked by Playwright.
3. Expand Hejhome API client only from redacted packet evidence.
4. Add device capability mappings one device class at a time.
5. Publish through npm Trusted Publishing after CI is stable.

## Active Execution Plan

[Homebridge 조직 스코프 이전 실행 계획](exec-plans/2026-10-03-homebridge-scope-migration.md)을 진행한다. [공식 신청 #1251](https://github.com/homebridge/plugins/issues/1251) 제출을 확인했으며, [제출 기록과 번역](exec-plans/2026-10-03-homebridge-scope-transfer-request.md)을 보존한다. 팀 답변은 1시간 간격으로 추적한다. v2·v3의 공식 검증 대비 보완과 후속 인증정보 보호 수정은 정식 `2.1.3`·베타 `3.0.2-beta.1`로 게시했다. 검증 범위와 공개 확인 결과를 실행 계획에 기록했다. 소유권 이전과 새 스코프 게시는 아직 실행하지 않았다. 이전 당시 선택한 버전 계열과 기존 로그인·액세서리·페어링을 보존하는 것이 완료 기준이다.

정식 [3.0.2](https://github.com/chazepps/homebridge-hejhome/releases/tag/v3.0.2)를 사용자의 요청에 따라 `latest`로 게시했다. 기존 [2.1.3](https://github.com/chazepps/homebridge-hejhome/releases/tag/v2.1.3)은 명시 버전과 `codex/hejhome-v2-maintenance`로 보존한다. `beta`는 `3.0.2-beta.1`을 유지한다. 전체 단위 597개·UI 123개·문서 37개와 원격 6개 CI 조합, 격리 Homebridge 실행 및 v2 복귀 검증을 통과했다. 공개 패키지 149개 파일·무결성·provenance가 검증 후보와 일치한다. [3.0 사용 안내](product-specs/3.0-beta-guide.md)와 이전 실행 계획에 최신 기준을 기록했다.

현재 `latest`는 README 목차 링크를 수정한 [3.0.3](https://github.com/chazepps/homebridge-hejhome/releases/tag/v3.0.3)이다. npm·GitHub의 실제 브라우저 이동과 공개 패키지 일치를 확인했다. 플러그인 기능 변경은 없다.

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
