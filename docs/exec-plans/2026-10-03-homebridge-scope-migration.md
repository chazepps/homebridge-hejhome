# Homebridge 조직 스코프 이전 실행 계획

> **For agentic workers:** 구현 단계는 `superpowers:subagent-driven-development` 또는 `superpowers:executing-plans`로 작업 단위별 진행한다. 체크 표시는 실제 산출물과 검증 결과가 있는 항목에만 적용한다.

**Goal:** 기존 사용자의 장치·로그인·설정을 보존하면서 `@chazepps/homebridge-hejhome`을 `@homebridge-plugins/homebridge-hejhome`으로 이전하고 v2 정식과 v3 베타를 계속 제공한다.

**Architecture:** 기존 GitHub 이력과 릴리스 채널을 유지하고 패키지 소유·게시 경로만 변경한다. Homebridge의 공식 GUI 전환 절차를 사용하되 HAP 캐시, 하위 브리지, Matter 저장 상태는 실제 이전 검증을 통과해야 한다. 저장소 이전, 패키지 이름 변경, 기존 사용자 전환 안내를 한 번에 공개하지 않고 검증 단계별로 진행한다.

**Tech Stack:** TypeScript, Homebridge HAP/Matter, Homebridge UI, npm 조직 패키지, GitHub Actions Trusted Publishing, Vitest, Playwright.

**Spec:** 사용자가 요청한 조직 스코프 이전 체크리스트와 [공식 Scoped Plugins 안내](https://github.com/homebridge/plugins/wiki/Scoped-Plugins), [이전 신청 양식](https://github.com/homebridge/plugins/blob/latest/.github/ISSUE_TEMPLATE/3_transfer-request.yml)을 기준으로 한다.

작성일: 2026-10-03. 상태: **사전 점검 및 신청 초안 작성. 외부 제출·소유권 이전·제품 코드 변경은 아직 실행하지 않음.**

## 1. 현재 확인된 기준선

| 항목 | 확인 결과 |
| --- | --- |
| 기존 npm 패키지 | `@chazepps/homebridge-hejhome` |
| 요청할 새 패키지 | `@homebridge-plugins/homebridge-hejhome` — 최종 사용 승인은 Homebridge 팀이 결정 |
| 저장소 | `chazepps/homebridge-hejhome`, 공개, 기본 브랜치 `main`, Issues 사용 |
| 유지보수 계정 | npm `chazepps`; 현재 GitHub 계정의 저장소 관리 권한 확인 |
| v2 정식 | `2.1.2`, `latest`, 태그 `v2.1.2`, 커밋 `37d0e40f0389d7230046902fa99962b103b0eef7` |
| v3 베타 | `3.0.1-beta.1`, `beta`, 태그 `v3.0.1-beta.1`, 커밋 `ddd5ae5b97723cd9ee532a3fb0ecf6e9b8ffe20a` |
| 개발 브랜치 | v2 `main`; v3 `codex/hejhome-3.0.0-beta` |
| Verified | 공식 `verified-plugins.json`에 기존 패키지 등록 확인 |
| 기존 검증 요청 | [homebridge/plugins #750](https://github.com/homebridge/plugins/issues/750), 종료된 Verification Request |
| 조직 스코프 전환 목록 | `has-scope-plugins.json`에 Hejhome 항목 없음 |
| 새 패키지 조회 | npm 공개 조회에서 404. 이름 예약·게시 권한이 승인됐다는 뜻은 아님 |
| 중복 신청 조회 | 기존 패키지명으로 공식 저장소의 열린/닫힌 이슈를 검색했을 때 #750만 확인. 제출 직전에 다시 검색 |

이 표의 값은 작업 당시 조회 결과다. 실제 이전 직전에 다시 조회하며, 그 사이 새 릴리스가 있으면 이전 기준 버전을 갱신한다. 기존 Verified 등록은 이번 패키지 이전이나 새 베타의 모든 기능에 대한 별도 승인으로 해석하지 않는다.

## 2. 전체 제약과 결정 사항

- 제품 표시 이름과 설정의 `platform: "Hejhome"`은 유지한다.
- 기존 장치의 HAP UUID, Matter UUID·endpoint 식별자, 하위 브리지 설정을 유지한다.
- 세션·기기 목록·전력 이력의 파일 경로와 계정 구분 방식을 유지한다.
- v2 `latest`와 v3 `beta`를 각각 게시한다. v3 베타를 정식 기본 설치로 바꾸지 않는다.
- 이전 릴리스에 새 장치 기능, UI 개편, 의존성 일괄 업데이트를 섞지 않는다.
- 사용자는 Homebridge GUI에서 전환한다. 공개 사용자 안내에 전역 npm 설치 명령을 기본 경로로 넣지 않는다.
- 기존 패키지·버전·릴리스 태그는 삭제하거나 덮어쓰지 않는다.
- 원본 토큰·쿠키·설정·장치 식별자는 이 문서, 공개 이슈, 테스트 산출물에 포함하지 않는다.
- 새 조직 패키지의 최초 게시는 Homebridge 팀과 조율한다. 로컬 코드에서 이름만 바꿔 먼저 게시하지 않는다.
- 공식 신청 조건은 조직에 이전한 뒤 다시 조직 밖으로 이전하지 않는 것이다. **이 조건의 수락과 공개 신청 제출은 소유자가 확인해야 한다.**

희망 유지보수 방식은 **기존 개발자가 계속 유지보수**하는 것이다. 팀에서 부여할 GitHub 역할, npm 게시 방식, 기존 개인 스코프 패키지의 처리 방법은 신청 답변으로 확정한다. 현재 새 조직의 쓰기 권한이나 Trusted Publisher 설정이 준비됐다고 가정하지 않는다.

## 3. 검토에서 우선 확인할 위험

1. 이전 패키지 이름이 남은 캐시: 기존 장치를 삭제·재생성하지 않고 새 플러그인에 연결해야 한다.
2. 이전/신규 패키지가 함께 로드되는 재시작: 동일 `Hejhome` 플랫폼이 두 번 실행되거나 캐시 복원이 모호해지면 안 된다.
3. v3 사용자 전환: 전환 GUI가 새 패키지의 `latest`를 선택해 v2로 내려가거나 Matter 액세서리를 잃으면 안 된다.
4. 계정·세션·이력 보존: 재로그인을 강요하거나 다른 계정의 저장 상태를 사용하거나 전력 누적값을 초기화하면 안 된다.
5. 저장소 이전 후 게시 권한: 잘못된 소유자·워크플로·채널로 게시하거나 이전된 과거 태그가 의도치 않게 다시 게시되면 안 된다.

1·2는 작업 D·F, 3은 작업 F, 4는 작업 C·D·F, 5는 작업 B·E의 완료 조건으로 검증한다.

### 코드 점검에서 확인한 주의점

현재 설치된 Homebridge 2.4.0의 `pluginManager`·`bridgeService`·`BaseMatterManager`에는 구 패키지가 없을 때 같은 활성 플랫폼 alias를 찾아 캐시를 새 플러그인에 연결하는 경로가 있다. 이 소스 확인을 Homebridge 1.8.x나 실제 페어링 보존의 검증으로 확대하지 않는다.

특히 **구 패키지를 제거하지 않고 비활성화만 한 채 재시작하는 경로는 사용하지 않는다.** 구 패키지 조회는 성공하지만 활성 플랫폼이 없어, HAP 캐시가 연결 대상 없는 액세서리로 제거될 수 있다. 두 패키지를 모두 활성화하면 `Hejhome` alias가 중복된다. 따라서 전환 검증에는 설치 유무뿐 아니라 `plugins`·`disabledPlugins` 설정도 포함해야 한다.

`platform`에 `@chazepps/homebridge-hejhome.Hejhome`처럼 구 패키지명까지 넣은 설정도 별도 처리 대상이다. 현재 초기화 코드는 `api.registerPlatform(PLATFORM_NAME, HejhomePlatform)`이며 구 이름의 번역 정보를 별도로 등록하지 않는다. 일반적인 `platform: "Hejhome"`만 통과시킨 뒤 모든 기존 설정이 호환된다고 판단하지 않는다.

## A. 사전 점검과 신청 초안 — 현재 단계

**담당:** 유지보수자와 작업 에이전트. **산출물:** 이 실행 계획과 [공식 신청 초안](2026-10-03-homebridge-scope-transfer-request.md).

- [x] 기존 패키지·버전·채널·브랜치·태그·게시 계정을 확인한다.
- [x] 공식 Verified 등록, 조직 스코프 전환 목록, 이전 요청 양식을 확인한다.
- [x] 기존 이슈와 신규 패키지 공개 여부를 읽기 전용으로 조회한다.
- [x] 제품 코드와 배포 도구에서 패키지명에 의존하는 지점을 조사한다.
- [x] Homebridge 2.4.0의 실제 로더 메서드와 메모리 fixture로 정상 3개·위험 3개 시나리오를 확인한다. 6개 assertion 통과는 위험 재현도 포함하며, 실제 페어링 이전 성공을 뜻하지 않는다.
- [x] 공식 양식에 맞춘 영문 신청 초안을 작성한다.
- [ ] 소유자가 계속 유지보수하는 선택, 조직 밖 재이전 제한, 신청 내용의 공개 제출을 확인한다.
- [ ] 중복 신청을 다시 검색한 뒤 `homebridge/plugins`에 **Plugin Transfer Request**를 제출하고 실제 이슈 URL을 기록한다.

**검증:** `npm run docs:check`와 `git diff --check` 통과. 공개 이슈 제출 완료 표시는 실제 URL과 제출 본문 확인 후에만 한다.

## B. Homebridge 팀과 이전 순서 확정

**입력:** 작업 A의 공개 신청. **산출물:** 이슈에서 확인된 승인 조건과 역할·게시 순서.

- [ ] 새 npm 이름과 GitHub 대상 조직·저장소 이름을 팀 답변으로 확정한다.
- [ ] 기존 GitHub 저장소의 이력·이슈·릴리스·브랜치 보존 및 유지보수자 권한을 확인한다.
- [ ] 기존 개인 스코프 패키지를 새 조직으로 옮기는 구체적인 방식과 원래 패키지 관리 권한을 확인한다.
- [ ] 정식·베타 모두 이전 시점의 대응 버전을 제공하는 일정과 최초 게시 담당자를 확정한다.
- [ ] 새 npm 패키지의 Trusted Publisher에 들어갈 GitHub 소유자, 저장소, `release.yml`, 환경 `npm`을 팀과 확인한다.
- [ ] GitHub 환경 보호 규칙·워크플로 실행 권한·비밀값 보존 여부를 점검하고 필요한 설정을 재구성한다. 비밀값 자체는 문서에 적지 않는다.

**완료 조건:** 이름·권한·최초 게시·두 채널·기존 사용자 전환 방식에 대한 답변이 모두 있다. 답변이 없는 항목은 완료 표시하거나 임의로 소유권을 변경하지 않는다.

## C. v2·v3의 이름 변경 패치 준비

**입력:** 작업 B의 확정된 이름과 저장소. **산출물:** v2·v3 각각의 검토 가능한 패치와 로컬 패키지.

v2는 `v2.1.2`, v3는 `v3.0.1-beta.1`을 현재 기준으로 별도 작업 공간에서 시작한다. 실행 시 새 버전이 게시됐다면 기준선을 먼저 갱신한다. 두 버전의 소스를 서로 합치지 않는다.

| 파일·영역 | 변경 또는 보존 내용 |
| --- | --- |
| `package.json`, `package-lock.json` | 패키지명·확정된 저장소 주소·아이콘 주소·게시 채널을 함께 갱신 |
| `src/settings.ts` | `PLUGIN_NAME`만 새 패키지명으로 변경. `PLATFORM_NAME = 'Hejhome'` 유지 |
| `src/index.ts`, `config.schema.json` | 플랫폼 alias `Hejhome` 유지, 동적 플랫폼 등록과 GUI 계약 유지 |
| `src/platform.ts` | HAP UUID는 `uuid.generate(device.id)` 유지. 등록·해제 호출의 새 `PLUGIN_NAME` 적용 확인 |
| `src/matter/adapter.ts` — v3 | `hejhome:matter:${device.id}` UUID 입력, 장치 식별자, 등록·복원 흐름 유지 |
| `src/storage/sessionStore.ts` | Homebridge 저장 공간의 `hejhome/session.json`과 계정 구분 방식 유지 |
| `src/storage/deviceSnapshotStore.ts` | `hejhome/devices-snapshot.json` 경로와 계정·집/방 범위 보존 |
| `src/storage/estimatedEnergyStore.ts` — v3 | `hejhome/estimated-energy-*.json` 경로, 소유자 계산식과 누적값 유지 |
| `src/runtime/commands.ts`, `src/runtime/status.ts` — v3 | `hejhome/runtime.sock`, `hejhome/runtime-status.json` 및 UI/런타임 통신 유지 |
| `homebridge-ui/src/pages/Help.tsx`, 한영 README | 확정된 저장소 링크로 변경. 스크린샷·가이드 링크까지 확인 |
| `.github/workflows/release.yml`, `tools/release/channel.mjs` | 조직 게시 권한, 명시적 채널, 패키지·lock·태그 일치 검사 |
| `tools/release/verify-host-matrix.mjs`, `tools/release/host-matrix-smoke.mjs` — v3 | 이전/신규 패키지를 별도로 설치·검증할 수 있도록 하드코딩된 패키지 이름과 import 경로 수정 |
| `tools/homebridge/verify-pi-runtime.mjs`, `tests/pi-verify-script.test.ts` | 기존 패키지 설치 경로를 고정한 검증이 신규 패키지를 잘못 검사하지 않도록 대상 이름을 구분 |
| 테스트의 패키지명 참조 | 새 이름만 일괄 치환하지 말고, 이전 이름의 캐시를 읽는 fixture를 별도로 유지 |

이름 변경의 핵심 값은 다음과 같다. 아직 제품 파일에 적용한 값은 아니다.

```ts
export const PLATFORM_NAME = 'Hejhome';
export const PLUGIN_NAME = '@homebridge-plugins/homebridge-hejhome';
```

- [ ] 먼저 `tests/scope-migration.test.ts`를 각 유지보수 계열에 추가하고 이전 이름의 캐시·설정 fixture를 만든다.
- [ ] 새 이름으로 로드할 때 기존 UUID·설정·계정 구분이 유지되는지 실패 테스트로 고정한다. v3는 Matter와 전력 이력도 포함한다.
- [ ] 구 이름을 포함한 `platform` 설정, `plugins` 허용 목록, `disabledPlugins` 목록을 탐지하는 fixture를 추가한다. GUI 전환 도구가 이를 처리하는지 먼저 확인하고, 처리하지 못하면 기존 설정 의도를 유지하는 교정 또는 호환 처리를 준비한다.
- [ ] 위 파일별 범위로 이름 변경 패치를 적용하고 해당 테스트를 통과시킨다.
- [ ] v2의 게시 채널도 명시적으로 검사한다. v3의 `releaseChannel()` 계약처럼 태그·패키지·lock 불일치 및 잘못된 채널은 게시 전에 실패해야 한다.
- [ ] 각 작업 공간에서 `npm ci`, `npm run verify`, `npm pack --dry-run`, `git diff --check`를 실행한다.
- [ ] 독립 리뷰에서 제품 기능 변경과 개인 개발환경 경로·비밀정보가 섞이지 않았는지 확인한다.

**완료 조건:** 실행 코드의 차이가 패키지 식별·이전 호환 처리 범위로 제한되고, 대응하는 구/신 패키지 사이의 기능과 버전 관계가 설명된다. 기존 테스트 통과만으로 실제 이전 성공을 선언하지 않는다.

## D. 캐시·로그인·페어링 보존 검증

**입력:** 작업 C의 구/신 패키지. **산출물:** 이전 전후 비교 결과와 실패·복귀 로그.

새 검증 도구는 `tools/release/verify-scope-migration.mjs`로 작성한다. 인터페이스는 `--old-tarball`, `--new-tarball`, `--node`, `--homebridge`, `--output`이다. 별도 임시 저장 공간에 구 패키지를 먼저 설치해 캐시를 생성한 다음, **같은 저장 공간**으로 새 패키지를 실행한다. 실제 개인 로그인 정보를 자동화 fixture에 넣지 않는다.

| 입력 조건 | 확인할 결과 |
| --- | --- |
| 기존 HAP 캐시와 `platform: "Hejhome"` | 등록된 액세서리 UUID·개수·서비스 식별자 유지, 불필요한 삭제·재등록 없음 |
| 기존 하위 브리지 | `_bridge` 식별·설정 및 액세서리 소속 유지 |
| 구 패키지 제거 전 중간 재시작 | 중복 플랫폼 실행 위험 감지. 사용자 전환 경로에서는 중간 재시작을 유발하지 않음 |
| 구 패키지가 설치된 채 비활성화됨 | 정상 이전 경로로 승인하지 않음. 잘못된 상태로 재시작하기 전에 전환 중단, 기존 캐시 사본 보존 |
| 구 패키지명을 포함한 platform·허용/비활성 목록 | 잘못된 플러그인 선택 없이 설정 의도를 보존하거나, 시작 전에 수정할 항목을 명시 |
| 기존 세션과 집/방 선택 | 세션 재사용, 계정 fingerprint 및 선택 범위 유지, 다른 계정 상태 혼용 없음 |
| v3 장치 숨김·표시 이름·연결 방식 | 기존 장치별 설정 유지, 숨긴 장치 재노출 없음 |
| v3 Matter paired storage | fabric·endpoint/part ID·UUID 유지, 재커미셔닝 필요 여부 확인 |
| v3 누적 전력 이력 | 소유자와 누적값 유지, 이전 중 공백 시간을 사용량으로 계산하지 않음 |
| 신규 패키지 설치 실패 | 기존 설치와 저장 데이터를 보존하고 기존 패키지로 재개 가능 |
| 새 패키지에서 기존 패키지로 복귀 | 같은 버전 계열의 HAP·Matter·세션 상태 재사용 가능 |

- [ ] 테스트 이름·실행 버전·전후 식별자 차이·결과를 `--output`의 JSON과 로그에 기록한다. 공개 결과에는 실제 식별자를 포함하지 않는다.
- [ ] v2는 Node 22.12.0·24.x 및 Homebridge 1.8.0·2.4.0에서 메인/하위 브리지 각각의 HAP 이전을 확인한다. 지원 범위의 조합이 설치되지 않으면 원인 해결 전 해당 범위의 이전 지원을 주장하지 않는다.
- [ ] v3는 Node 22.13.0·24.x·26.x 및 Homebridge 2.4.0·게시 당시 beta를 고정해 HAP 전용/Matter 전용/양쪽 연결과 메인/하위 브리지 이전을 확인한다.

**완료 조건:** 같은 저장 공간을 사용하는 격리 프로세스에서 HAP/Matter 캐시·세션·이력 복원과 잘못된 설치 구성의 실패 처리를 검증한다. 이 단계는 실제 Apple Home/Matter 컨트롤러의 페어링 보존을 증명하지 않으며, 공개 패키지의 GUI·실기 이전은 작업 F에서 검증한다. 오류가 난 단계만 원인을 분석해 수정·재검증한다.

## E. 조직 이전과 최초 게시

**입력:** 작업 B의 승인과 C–D의 검증. **산출물:** 조직 저장소, 새 패키지, 공개 릴리스와 두 채널 조회 결과.

- [ ] Homebridge 팀이 안내한 순서로 저장소와 게시 권한을 이전한다. 사용자에게 자동 전환을 권장하는 공식 매핑과 안내는 작업 F가 끝날 때까지 보류한다.
- [ ] 이전 직후 저장소 기본 브랜치·보호 규칙·환경 `npm`·유지보수 권한을 재확인한다. 과거 태그를 다시 push해 게시 워크플로를 실행하지 않는다.
- [ ] 팀 담당자가 새 스코프의 최초 정식·베타 패키지를 게시한다. 기존 대응 버전 번호를 유지할지 별도 이전 버전을 사용할지는 B에서 확정한 정책을 따른다.
- [ ] 새 패키지의 `latest`가 v2, `beta`가 v3인지 직접 조회하고 GitHub Latest도 정식 v2인지 확인한다.
- [ ] 공개 tarball의 무결성·내용·provenance가 검증한 후보와 일치하는지 확인한다.
- [ ] 초기 릴리스에 조직 이전용 버전임을 표시하고 기존 기능 제한을 유지한다. 기존 패키지의 사용자에게 전환을 권장하는 안내는 작업 F 이후 공개한다.

**완료 조건:** 새 스코프의 두 채널이 공개되고 파일 검증을 통과했다. 아직 기존 사용자 전환 완료나 실제 페어링 보존 완료로 기록하지 않는다.

## F. Homebridge GUI 전환과 두 채널 검증

**입력:** 작업 E의 공개 패키지와 Homebridge 팀의 등록 절차. **산출물:** 사용자 전환 경로 및 버전 선택 결과.

- [ ] 공식 `has-scope-plugins.json`의 `from`·`to`·`switch` 처리 방식과 GUI 전환 도구의 지원 버전을 확인한다. 기존 설정 GUI 최소 버전과 조직 전환 도구의 최소 버전을 혼동하지 않는다.
- [ ] 공개 매핑 등록 전에, 실제 Homebridge UI 전환 구현에 테스트용 매핑 응답을 연결해 **v2 → 새 v2**, **v3 베타 → 새 v3 베타**의 선택과 설치 순서를 검증한다. 베타가 `latest`로 바뀌면 교정 전 매핑을 공개하지 않는다.
- [ ] 지정된 개발용 Homebridge에서 전환 전 저장 공간 사본과 액세서리 목록을 보관한다.
- [ ] 개발 환경의 GUI에서 새 패키지 설치 → 기존 패키지 제거 → 재시작 순서를 검증한다. 정상 절차에서 구 패키지를 disabled 상태로 공존시키지 않는다.
- [ ] GUI 전환 후 로그인, 장치 제어, 상태 재수신, 재시작 두 번, Apple Home의 방·장면·자동화를 확인한다.
- [ ] 새 패키지 이름으로 설정 화면을 다시 열고 로그인 상태·장치 목록·저장·하위 브리지 재시작 안내를 확인한다. Config UI X의 UI 파일 조회도 새 패키지 기준이어야 한다.
- [ ] v3 Matter의 실제 앱 연결 보존을 확인한다. 자동화된 native-host 테스트와 실제 컨트롤러의 paired 상태 검증을 구분해 기록한다.
- [ ] 위 결과와 매핑 값을 Homebridge 팀에 전달해 공식 전환 목록에 등록한다. `switch`의 의미를 추측해 임의의 버전을 지정하지 않는다.
- [ ] `verified-plugins.json`, 표시 이름·아이콘·관련 등록 정보가 새 패키지를 가리키는지 확인한다.
- [ ] 공식 매핑 적용 후 Scoped/Verified 표시와 전환 버튼을 다시 확인한다. 실제 GUI가 검증한 것과 다른 버전을 선택하면 전환 권장을 중단한다.
- [ ] 같은 이름의 플러그인이 검색 결과에 두 개 보일 때 권장 패키지와 이전 안내가 명확한지 확인한다. 버전 조회에서도 정식·베타와 각 엔진 조건을 확인한다.
- [ ] 한영 README·릴리스 노트·기존 패키지에 GUI 이전 및 복귀 안내를 공개한다.

**완료 조건:** 전환 과정에서 새 패키지 설치 → 기존 패키지 제거 → 재시작 순서가 유지되고, 사용자에게 CLI 조작을 요구하지 않는다. v3 베타 사용자가 의도치 않게 v2로 바뀌지 않으며, 실제 paired HomeKit/Matter 환경의 유지 증거가 있다.

## G. 복귀와 종료

- [ ] 문제가 발견되면 신규 전환 권장을 중단하고 영향받는 계열을 명시한다. 정상 동작하는 다른 채널을 함께 되돌리지 않는다.
- [ ] 기존 패키지의 같은 계열·검증된 버전으로 GUI 복귀를 확인한다. 저장 공간은 필요할 때만 전환 전 사본으로 복원하며 기본 해결책으로 페어링을 초기화하지 않는다.
- [ ] v3 → v2 기능 다운그레이드는 패키지 이름 이전 복귀와 별개로 취급한다. Matter와 `features` 설정 정리는 기존 베타 복귀 안내를 따른다.
- [ ] 기존 npm 버전은 유지하고, 신규 패키지 확인 후에만 기존 패키지의 배포 중단 안내 여부·시점을 팀과 결정한다.
- [ ] 실제 신청 URL, 이전 커밋, CI, 패키지 무결성, 채널, GUI 확인, 실기 확인·미확인 범위를 이 문서에 기록하고 작업 공간을 정리한다.

**종료 조건:** 조직 이전과 두 채널 공개가 확인되고, 기존 사용자의 정상 이전 및 복귀가 검증됐으며, 남은 제한이 사용자 안내에 반영돼 있다.

## 4. 읽기 전용 재확인 명령

아래 명령은 유지보수자 점검용이다. 사용자 설치 안내는 작업 F의 GUI 절차를 사용한다.

```sh
git status --short
git rev-parse 'v2.1.2^{commit}' 'v3.0.1-beta.1^{commit}'
npm view @chazepps/homebridge-hejhome dist-tags --json
gh issue list --repo homebridge/plugins --state all --search '"@chazepps/homebridge-hejhome"' --json number,title,state,url
gh api repos/homebridge/plugins/contents/.github/ISSUE_TEMPLATE/3_transfer-request.yml
npm run docs:check
git diff --check
```

새 스코프 권한이나 제출 승인을 읽기 전용 조회 성공만으로 간주하지 않는다.

## 5. 공식 근거

- [Scoped Plugins와 GUI 전환](https://github.com/homebridge/plugins/wiki/Scoped-Plugins)
- [Plugin Transfer Request 양식 및 유지보수 조건](https://github.com/homebridge/plugins/blob/latest/.github/ISSUE_TEMPLATE/3_transfer-request.yml)
- [Verified Plugins 기준과 등록 목록](https://github.com/homebridge/plugins/wiki/Verified-Plugins)
- [기존 → 신규 패키지 전환 목록](https://github.com/homebridge/plugins/blob/latest/has-scope-plugins.json)
- [현재 프로젝트의 베타 사용·복귀 안내](../product-specs/3.0-beta-guide.md)
