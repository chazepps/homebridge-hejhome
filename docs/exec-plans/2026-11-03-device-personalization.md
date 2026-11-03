# Device Personalization Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans in this worktree, with test-driven-development and a fresh final reviewer.

**Goal:** 즐겨찾기 채널·공기청정기 모드 순간 버튼과 포트별 표시 이름을 설정 UI에서 관리한다.

**Architecture:** 기존 액세서리에 고정 subtype의 HAP 순간 스위치를 추가한다. 검증된 단일 명령을 기존 직렬 제어 경로로 보내고 보고 상태를 추정하지 않는다. 포트 이름은 HAP/Matter 식별자를 유지한다.

**Tech Stack:** TypeScript, Homebridge 2.4+, React/Radix, Vitest, Playwright.

**Spec:** 앞선 대화에서 검토하고 사용자가 구현을 요청한 첫 묶음의 범위를 이 문서에 명시한다.

## Global Constraints

- 기존 설정의 동작과 package version을 유지한다. 게시·배포·브랜치 병합은 포함하지 않는다.
- favoriteChannels: TV/셋톱 전용, 최대 8개, 고정 id(영문 소문자·숫자·하이픈 1–24자), name 1–32자, channel 정수 0–999.
- purifierModeButtons: Airpurifier 전용 opt-in. 자동·수동·취침 명령을 각각 한 번 전송한다.
- 추가 버튼은 HAP에만 제공한다. Matter-only/hidden에는 노출하지 않고 설정은 보관한다.
- channelNames: 다구 스위치·멀티탭 전용, power1–power6 중 실제 제어 포트. 멀티탭 power5 전체 명령은 제외한다. 이름 1–64자.
- 포트 UUID/subtype/part id와 명령 키를 유지한다. 이름 삭제 시 기본 이름을 복원한다.
- 읽기는 항상 OFF이며 명령 성공 뒤 OFF로 복귀한다. 실패 자동 재시도와 실제 장치 상태 추정은 하지 않는다.

## Review Focus

- 버튼 이름·번호 변경에도 id와 서비스가 유지되어야 한다.
- 삭제·비활성화·장치 타입 변경 시 소유한 추가 서비스만 제거한다.
- 새 설정 저장 시 기존 powerSpec과 계정 경계를 보존한다.
- 포트 이름은 기존 캐시에도 반영되고 비운 이름은 기본값으로 돌아간다.
- 숨김·Matter-only 전환과 모바일 UI에서 저장·초기화가 일관되어야 한다.

### Task 1: 설정 계약과 HAP 순간 버튼

- [x] normalizeFeatures·네이티브 HAP 테스트에 유효/잘못된 설정, 반복 입력·실패·서비스 제거 테스트를 먼저 추가하고 실패를 확인한다.
- [x] 공통 personalization 검증, favoriteChannels/purifierModeButtons 설정과 버튼 실행 경로를 구현한다.
- [x] 관련 단위 테스트 통과를 확인한다.

### Task 2: 포트 이름과 설정 UI

- [x] 이름 변경 전후 HAP subtype·Matter part id·명령 키 유지, UI 직렬화·서버 검증 테스트를 먼저 추가한다.
- [x] channelNames를 기존 HAP/Matter 생성·캐시 갱신에 연결한다.
- [x] UI에 채널 추가/삭제, 청정기 토글, 포트별 이름 입력을 제공한다. 기존 초안·저장 경로를 사용한다.
- [x] API 저장 검증·설정 스키마·모바일 브라우저 회귀를 확인한다.

Matter 하위 포트는 부모 전용 BridgedDeviceBasicInformation을 가지지 않는다. 설치된 Homebridge가 사용하는 Descriptor Number tag 라벨을 갱신하며 namespace 7·기존 tag 번호·endpoint ID를 유지한다. 실제 Matter endpoint의 캐시 복원·이름 수정·기본값 복원을 검증한다.

### Task 3: 문서·최종 검증·리뷰

- [x] 한국어/영어 사용 안내와 생성 문서를 갱신한다.
- [x] lint, typecheck, build, npm test, test:ui, docs:check, npm pack --dry-run을 통과한다.
- [x] 별도 리뷰어의 중요한 지적을 수정하고 관련 테스트를 다시 통과한다.

검증 결과: 기준 단위 634개에서 최종 645개로 확장, 전체 브라우저 129개 통과. lint·typecheck·build·docs:check·패키지 dry-run 통과. 별도 읽기 전용 리뷰에서 발견한 중요 2건(미보고 캐시 포트의 이름 복원, 장치 타입 변경 후 부적합 설정 삭제 UI)을 회귀 테스트의 실패→수정→성공으로 확인했다. 실제 기기 동작과 컨트롤러의 사용자 지정 이름 우선순위는 검증하지 않았다. 커밋·병합·게시·운영 설치는 실행하지 않았다.

## Release Impact and Rollback

기본값은 모두 비활성/미설정이다. 새 설정을 제거하고 재시작하면 추가 버튼이 제거되고 기본 포트 이름으로 돌아간다. 실제 TV·청정기 반응과 Apple Home의 사용자 지정 이름 우선순위는 실기 인수 항목으로 남긴다.
