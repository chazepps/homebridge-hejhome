<p align="center">
  <img src="https://raw.githubusercontent.com/chazepps/homebridge-hejhome/main/branding/logo.png" alt="Hejhome 로고" height="150">
</p>

<h1 align="center">Homebridge Hejhome Plugin</h1>

<p align="center">
  헤이홈 장비를 Apple Home 앱과 HomeKit에서 사용할 수 있게 연결하는 Homebridge 플러그인입니다.
</p>

<p align="center">
  <a href="https://github.com/homebridge/homebridge/wiki/Verified-Plugins"><img alt="Homebridge verified" src="https://img.shields.io/badge/homebridge-verified-491F59?style=for-the-badge&logo=homebridge&logoColor=white"></a>
  <img alt="Node.js 22 or 24" src="https://img.shields.io/badge/node.js-22.12%2B%20%7C%2024.x-339933?style=for-the-badge&logo=node.js&logoColor=white">
  <img alt="Homebridge 1 or 2" src="https://img.shields.io/badge/homebridge-1.8%2B%20%7C%202.x-491F59?style=for-the-badge">
  <img alt="License ISC" src="https://img.shields.io/badge/license-ISC-0f766e?style=for-the-badge">
</p>

## 🎉 버전 2가 드디어 출시되었습니다

`@chazepps/homebridge-hejhome` v2는 기존 구현을 버리고 Homebridge 공식 Dynamic Platform Plugin 구조로 새로 만든 릴리스입니다.

이번 프로젝트는 **100% Codex로 개발**되었고, [Hejhome for Web](https://square.hej.so/) 사이트의 로그인, 장비 목록 조회, 제어 요청, 실시간 상태 갱신 흐름을 Homebridge 환경에서 유사하게 따라가도록 제작했습니다. Homebridge 설정 화면에서 로그인하고, 발견된 헤이홈 장비를 Home 앱 액세서리로 사용할 수 있게 만드는 것이 목표입니다.

## 개요

`@chazepps/homebridge-hejhome`은 헤이홈 클라우드 장비를 HomeKit 액세서리로 노출하는 Dynamic Platform Plugin입니다. Homebridge 공식 플러그인 규칙에 맞춰 TypeScript, Custom Config UI, 세션 저장소, 장비 스냅샷, 실시간 상태 갱신 구조를 갖추고 있습니다.

로그인은 Homebridge 설정 화면 안에서 진행됩니다. 이메일 인증번호 확인 후 비밀번호를 한 번 입력하면, 자동 로그인 세션을 Homebridge 저장 공간에 저장합니다. 비밀번호와 인증번호는 저장하지 않습니다.

## 주요 기능

- Homebridge 공식 Dynamic Platform Plugin 구조 사용
- Homebridge Config UI 안에서 Hejhome 이메일 로그인 지원
- 세션 정보는 `config.json`이 아니라 Homebridge 저장 공간에 분리 저장
- Hejhome 장비 목록 스냅샷 저장
- 장비 추가, 갱신, 제거를 Homebridge 캐시 액세서리와 동기화
- REST 제어 요청과 realtime 상태 갱신 지원
- 설정 화면에서 로그인 상태, 장비 수, 지원/부분 지원/보류 제품군 표시
- 미지원 장비를 발견하면 GitHub 이슈용 템플릿 제공
- lint, typecheck, unit test, UI test, build, docs check, npm pack 검증 포함

## 현재 지원 제품군

아래 목록은 `src/devices/capabilities.ts`의 capability registry를 기준으로 다시 점검한 현재 지원 범위입니다. HomeKit 의미가 명확한 장비만 안정 지원으로 분류하고, 불명확한 장비는 부분 지원 또는 후속 구현 대상으로 둡니다.

### 안정 지원

| 제품군 | Hejhome 타입 | HomeKit 표시 |
| --- | --- | --- |
| RGB/RGBW 조명, LED 스트립 | `LightRgbw1`, `LightRgbw2`, `LightRgbw3`, `LightRgbw4`, `LightRgbw5`, `LightRgb4`, `LightRgb5`, `LedStripRgb`, `LedStripRgbw1`, `LedStripRgbw2` | 전구 |
| 색온도 조명 | `LightWw1`, `LightWw2`, `LightWw3` | 전구 |
| 벽 스위치 | `Switch1`, `Switch2`, `Switch3`, `Switch4`, `Switch5`, `Switch6`, `ZigbeeSwitch1`, `ZigbeeSwitch2`, `ZigbeeSwitch3` | 스위치 |
| 릴레이 | `Relay`, `RelayController`, `RelayController2`, `RelayControllerDc`, `RelayControllerDc2` | 스위치 |
| 플러그 | `Plug`, `SmartPlug`, `BruntPlug` | 콘센트 |
| 멀티탭 | `PowerStrip`, `PowerStrip2` | 콘센트 |
| 커튼/블라인드 | `Curtain`, `Blind`, `Blind2` | 커튼/블라인드 |
| 모션 센서 | `SensorMo`, `SensorRadar` | 모션 센서, 배터리 |
| 문 열림 센서 | `SensorDo` | 문 열림 센서, 배터리 |
| 온습도 센서 | `SensorTh`, `SensorTh2`, `SensorRefTh`, `SensorRefTh2` | 온도 센서, 습도 센서, 배터리 |
| 누수 센서 | `SensorWater2`, `SensorWater3` | 누수 센서, 배터리 |
| 연기 센서 | `SensorSmoke3`, `SensorSmoke4` | 연기 센서, 배터리 |
| 스마트 버튼 | `SmartButton` | 버튼, 배터리 |

### 부분 지원

| 제품군 | Hejhome 타입 | 현재 상태 |
| --- | --- | --- |
| IR TV/셋톱박스/프로젝터/램프/스피커/DVD/카메라/DIY 리모컨 | `IrTv`, `IrSettopbox`, `IrProjector`, `IrLamp`, `IrSpeaker`, `IrDvd`, `IrTvbox`, `IrCamera`, `IrDIY` | 전원처럼 의미가 명확한 명령만 스위치로 보수 지원 |
| IR 에어컨 | `IrAirconditioner` | 전원, 온도, 운전 모드 중심으로 보수 지원 |
| IR 선풍기 | `IrFan` | 전원과 바람 세기 중심으로 보수 지원 |
| 센서/알림/도어락 계열 | `AudibleAlarm`, `SensorGas2`, `SensorSmoke`, `SensorSos`, `SensorWater`, `Siren`, `SmartDoorLock`, `ZigbeeDoorlock` | 상태값 의미를 더 확인한 뒤 HomeKit 매핑 확장 예정 |
| 공기 관리 장비 | `Airpurifier`, `IrAirpurifier` | 전원과 모드 상태는 확인됐지만 HomeKit 매핑 추가 검증 필요 |

### 후속 구현 대상

| 제품군 | Hejhome 타입 | 현재 상태 |
| --- | --- | --- |
| 홈 카메라 | `HomeCamera`, `HomeCameraPro`, `HomeCameraProPlus` | API 분석은 진행했지만 HomeKit 영상 스트리밍 연동은 다음 단계 |

## 설치

Homebridge UI에서 플러그인을 설치하거나 npm으로 설치합니다.

```sh
npm install -g @chazepps/homebridge-hejhome
```

Homebridge 설정에는 platform만 추가하면 됩니다.

```json
{
  "platform": "Hejhome",
  "name": "Hejhome"
}
```

설치 후 Homebridge UI에서 Hejhome 플러그인 설정을 열고 이메일 인증과 비밀번호 로그인을 진행하세요. 비밀번호 입력 칸은 인증번호 확인이 끝난 뒤에만 활성화되며, 비밀번호는 디스크에 저장하지 않습니다.

## 로컬 개발

가능하면 `.nvmrc`의 Node 버전을 사용합니다.

```sh
nvm use
npm install
npm run build
npm run homebridge:dev
```

Homebridge Config UI까지 함께 띄울 때는 다음 명령을 사용합니다.

```sh
npm run homebridge:ui
```

로컬 개발용 Homebridge 설정은 `test/hbConfig/config.json`에 있습니다.

## 검증

개발 중에는 아래 명령으로 품질 게이트를 확인합니다.

```sh
npm run lint
npm run typecheck
npm test
npm run test:ui
npm run build
npm run docs:check
npm pack --dry-run
```

## 릴리스

릴리스는 `v*` 태그를 기준으로 GitHub Actions에서 npm에 배포합니다. 릴리스 워크플로우는 의존성 설치, 검증 게이트, `npm pack --dry-run`을 실행한 뒤 npm Trusted Publishing과 provenance를 사용해 배포합니다.

npm에 Trusted Publisher 설정을 먼저 완료한 뒤 태그를 푸시합니다.

```sh
git tag v2.0.0
git push origin v2.0.0
```

## 프로젝트 구조

| 경로 | 역할 |
| --- | --- |
| `src/platform.ts` | Homebridge dynamic platform 생명주기, 장비 discovery, realtime 연결 |
| `src/platformAccessory.ts` | HomeKit 액세서리 서비스 구성과 장비 제어 |
| `src/devices/capabilities.ts` | Hejhome 타입별 지원 상태와 HomeKit 매핑 |
| `src/hej/` | Hejhome Web 인증, REST, realtime 클라이언트 |
| `src/storage/` | 세션, 장비 스냅샷, 로그 저장소 |
| `homebridge-ui/` | Homebridge Custom Config UI와 UI 서버 |
| `docs/` | 제품, 프론트엔드, 신뢰성, 보안, 아키텍처 문서 |

## 기여

장비 지원은 실제 장비 데이터가 있을 때 가장 정확하게 확장할 수 있습니다. 아직 지원하지 않거나 부분 지원 중인 장비가 있다면 플러그인 설정 화면에 표시되는 GitHub 이슈 템플릿을 사용해 제보해 주세요.

Pull Request에는 관련 테스트 업데이트가 포함되어야 하며, 위 검증 명령을 통과해야 합니다.

## 라이선스

ISC. 자세한 내용은 [LICENSE](LICENSE)를 확인하세요.
