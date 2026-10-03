# Homebridge 조직 이전 신청 초안

상태: **미제출**. 아래 선택은 계속 유지보수하는 방향의 제안이다. 조직 밖으로 다시 이전하지 않는 공식 조건과 공개 제출을 소유자가 확인한 후 제출한다. 전체 작업 순서는 [이전 실행 계획](2026-10-03-homebridge-scope-migration.md)을 따른다.

제출 위치: [Plugin Transfer Request](https://github.com/homebridge/plugins/issues/new?template=3_transfer-request.yml).

제목: **Transfer Request: @chazepps/homebridge-hejhome**

아래 내용은 공식 양식의 필드별 제출 초안이다. 계정 이메일, 비밀값, 개인 장치 정보는 포함하지 않는다.

---

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
