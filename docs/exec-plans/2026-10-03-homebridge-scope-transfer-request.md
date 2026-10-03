# Homebridge 조직 이전 신청 기록 및 한국어 번역

상태: **[공식 이슈 #1251](https://github.com/homebridge/plugins/issues/1251) 제출 확인**. 작성자는 `chazepps`이며, 실제 신청에서 계속 유지보수하는 선택과 조직 밖 재이전 제한을 이해한다는 내용을 확인했다. 이 문서의 한국어는 검토용 번역이며, 실제 제출 내용은 공개 이슈가 기준이다. 전체 작업 순서는 [이전 실행 계획](2026-10-03-homebridge-scope-migration.md)을 따른다.

제출 위치: [Plugin Transfer Request](https://github.com/homebridge/plugins/issues/new?template=3_transfer-request.yml).

실제 이슈 제목: **Transfer Request: homebridge-hejhome**

아래 내용은 제출 전 준비한 공식 양식의 필드별 내용과 번역이다. 계정 이메일, 비밀값, 개인 장치 정보는 포함하지 않는다.

---

## 한국어 검토본

**제목:** 이전 요청: @chazepps/homebridge-hejhome

| 신청 항목 | 내용 |
| --- | --- |
| 플러그인 이름 | `@chazepps/homebridge-hejhome` |
| npm 사용자명 | `chazepps` |
| GitHub 저장소 | https://github.com/chazepps/homebridge-hejhome |
| 앞으로도 유지보수할 계획인가요? | 예. 계속 유지보수하겠습니다. |
| `@homebridge-plugins/` 스코프를 요청하나요? | 예. Homebridge Plugins 조직 스코프를 요청합니다. |

### 추가 설명

저는 `@chazepps/homebridge-hejhome`의 유지보수자입니다. Homebridge 팀과 협의하여 이 플러그인을 Homebridge Plugins 조직으로 이전하고자 합니다. 새 npm 패키지 이름으로 `@homebridge-plugins/homebridge-hejhome`을 제안합니다.

현재 패키지는 이미 Verified 목록에 등록되어 있습니다. 최초 검증 요청은 [#750](https://github.com/homebridge/plugins/issues/750)입니다.

이전 후에도 제가 계속 유지보수할 계획입니다. 이전 정책에 따라 플러그인은 Homebridge Plugins 조직에 남게 되며, GitHub Actions를 통해 패키지를 게시하게 된다는 점을 이해하고 있습니다.

현재 두 개의 릴리스 채널을 유지하고 있습니다.

| 채널 | 현재 버전 | 지원 환경 |
| --- | --- | --- |
| 정식 `latest` | 2.1.2 | Homebridge 1.8 이상인 1.x 또는 2.x, Node.js 22.12 이상인 22.x 또는 24.x |
| 베타 `beta` | 3.0.1-beta.1 | Homebridge 2.4 이상인 2.x, Node.js 22.13 이상인 22.x 또는 24.x·26.x |

베타에는 새로 구성한 설정 화면과 사용자가 선택해서 활성화하는 Matter 지원이 포함됩니다. 정식 버전 사용자는 베타를 직접 선택하지 않는 한 계속 v2 업데이트를 받아야 합니다.

두 채널 모두 자동 테스트와 공개 GitHub 릴리스를 제공하고 있습니다. 현재 npm 게시는 GitHub Actions의 Trusted Publishing을 사용하며, 빌드 출처를 검증할 수 있는 provenance도 포함합니다. 베타는 격리된 실제 Homebridge 실행 환경에서도 테스트했습니다. 다만 이 결과가 패키지 스코프 이전이나 모든 실물 장치 모델의 검증을 완료했다는 뜻은 아닙니다.

기존 사용자에게 전환을 제공하기 전에 `Hejhome` 플랫폼 이름, 캐시에 저장된 액세서리 식별자, 하위 브리지 설정, 로그인 정보, 베타의 Matter 연결 및 저장 상태가 유지되는지 확인하려고 합니다. 스코프 이전은 기능 변경과 분리해서 진행하겠습니다.

올바른 순서로 이전을 준비할 수 있도록 다음 사항을 확인해 주시겠습니까?

1. **이전 대상과 절차:** 대상 GitHub 저장소와, 이미 `@chazepps` 스코프에 속한 npm 패키지를 이전하는 절차가 궁금합니다.
2. **유지보수·게시 권한:** 이전 후 유지보수자 권한과 Trusted Publishing 설정, 새 스코프에 최초로 게시할 담당자를 확인하고 싶습니다.
3. **두 채널의 최초 게시:** 기존 패키지와 새 패키지의 전환 연결 정보를 등록하기 전에, 대응하는 정식·베타 버전을 새 스코프에 먼저 게시해야 하는지 확인 부탁드립니다.
4. **베타 선택 유지:** Homebridge GUI에서 전환할 때 기존 베타 사용자가 새 패키지의 정식 `latest` 버전으로 바뀌지 않고 베타 선택을 유지하는 방법이 궁금합니다.
5. **기존 설정 처리:** 구 패키지명을 포함한 플랫폼 설정이나 `plugins`·`disabledPlugins` 항목을 전환 도구가 처리하는지, 아니면 재시작 전에 별도로 확인·정리해야 하는지 확인 부탁드립니다.

사용자에게 전환을 안내하기 전에, 검토하실 수 있도록 이전 패치와 검증 결과를 제공하겠습니다.

---

<details>
<summary>영문 제출 내용</summary>

## Plugin Name

@chazepps/homebridge-hejhome

## NPM Username

chazepps

## Link To GitHub Repo

https://github.com/chazepps/homebridge-hejhome

## Do you plan to continue maintaining the plugin?

Yes - I will continue to maintain the plugin

## Are you requesting a `@homebridge-plugins/` scope for this plugin?

Yes - I am requesting a @homebridge-plugins/ scope for this plugin

## More Information

I maintain `@chazepps/homebridge-hejhome` and would like to request a coordinated transfer to the Homebridge Plugins organization, with the proposed npm name `@homebridge-plugins/homebridge-hejhome`.

The existing package is already listed as verified. The original verification request is [#750](https://github.com/homebridge/plugins/issues/750).

I plan to continue maintaining the plugin. I understand the transfer policy states that the plugin will remain in the Homebridge Plugins organization and that publishing will be managed through GitHub Actions.

There are two maintained release channels:

| Channel | Current version | Compatibility |
| --- | --- | --- |
| Stable `latest` | 2.1.2 | Homebridge 1.8+ within 1.x, or 2.x; Node.js 22.12+ within 22.x, or 24.x |
| Prerelease `beta` | 3.0.1-beta.1 | Homebridge 2.4+ within 2.x; Node.js 22.13+ within 22.x, 24.x, or 26.x |

The beta adds a redesigned settings UI and opt-in Matter support. Stable users should continue receiving v2 unless they explicitly select the beta.

Both channels have automated tests and public GitHub releases, and npm publishing currently uses GitHub Actions Trusted Publishing with provenance. The beta has also been tested in isolated native Homebridge environments. These checks do not yet constitute validation of a package-scope migration or every physical device model.

Before enabling migration for existing users, I intend to validate preservation of the `Hejhome` platform alias, cached accessory identity, child-bridge settings, sign-in data, and the beta's Matter connection and stored state. The scope migration will be kept separate from feature changes.

Could you confirm the following so I can prepare the transfer in the expected order?

1. The destination GitHub repository and the process for migrating an already scoped npm package from `@chazepps`.
2. The maintainer permissions and the Trusted Publishing configuration, including who will perform the first publication under the new scope.
3. Whether matching stable and beta versions should be published under the new scope before registering the migration mapping.
4. How Homebridge UI migration should preserve a user's beta selection without switching the installation to the new package's stable `latest` version.
5. Whether the migration tool handles an old package-qualified platform name or `plugins` / `disabledPlugins` entries, or whether these need an explicit preflight step before restarting.

I can provide the migration patch and verification results for review before migration is advertised to users.

</details>
