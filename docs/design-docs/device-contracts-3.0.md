# Hejhome 장치 계약: 3.0 추가 범위

2026-09-30 공개 공급자 Web 클라이언트와 [헤이홈 스마트 버튼 안내](https://m.hej.life/skin-skin5/board/app/read.html?board_no=16&no=128)를 읽기 전용으로 확인했다. 아래 `map:` 경로와 줄은 [공개 Web 소스맵](https://square.hej.so/static/js/main.5819c1ee.chunk.js.map)의 `sourcesContent` 기준이다. 화면 코드가 만든 요청과 표시 의미만 근거로 삼는다. 장치별 서버 수락, 물리 반응, 펌웨어 차이와 실제 컨트롤러 자동화는 별도 검증 대상이다. 소스 코드나 인증 자료는 이 문서에 복사하지 않았다.

| 범위 | 공개 코드로 확인한 상태·명령 | 3.0 구현 경계 |
| --- | --- | --- |
| B1 스마트 버튼 | [공식 제품 안내](https://m.hej.life/skin-skin5/board/app/read.html?board_no=16&no=128)는 버튼당 한 번·두 번·길게 누르기의 세 동작과 총 12개 자동화 액션을 설명한다. 이 설명에서 4개 버튼은 산술적으로 추론된다. Web의 `map:components/dashboard/liveEvent.js:141-146`은 `SmartButton`의 `pir` 보고에서 `t`만 보존한다. | 물리 제스처는 확인되지만 report의 버튼 번호·제스처 값·press/release·중복 식별값은 공개 코드에 없다. 특정 HomeKit/Matter 이벤트 enum으로 변환하지 않는다. 원본값을 개인 식별 없이 수집·대조한 뒤 추가한다. |
| B4 레이더 | 공개 Web은 `SensorRadar`의 `pir` 보고 시각 `t`만 보존하고 이를 모션 날짜 화면에 포함한다. `SensorMo` 이력은 `pir`/`none`과 `t`를 움직임 이벤트로 다룬다. | 같은 `pir` 코드의 명시적인 `pir`/`none`은 순간 움직임으로만 읽을 수 있다. 레이더의 지속 재실, 부재 판정 지연, 정지 인체 감지는 확인되지 않았다. OccupancySensor로 승격하지 않는다. |
| B5 커튼·블라인드 | 공개 Web에서 `Curtain`은 위치 0–100과 끝의 열림·닫힘 명령을 보내며 100은 열림, 0은 닫힘이다. `Blind/Blind2`는 목표 위치만 보낸다. 별도 현재 위치·목표 위치·열림/닫힘 보고가 있으며, 목록의 Curtain 표시는 현재 위치를 사용한다. | 현재/목표 위치를 분리하고 확인된 위치 명령만 제공한다. 공개 패널에 stop/tilt 요청이나 각도 보고·단위가 없으므로 HoldPosition·Matter stopMotion·tilt를 성공 기능으로 노출하지 않는다. 열림·닫힘 명령은 정지 명령이 아니다. |
| B6 공기청정기 | 공개 Web의 두 공기청정기 화면은 전원값과 자동·수동·취침 모드값을 제어 요청에 넣는다. 실시간 전원 보고를 명시적으로 처리하는 분기는 **`Airpurifier`에만** 있다. PM2.5 숫자를 화면에 표시하고 네 등급으로 나누지만 물리 단위·배율·결측 범위를 명시하지 않는다. | `Airpurifier`만 HAP/Matter의 알려진 전원값으로 Switch와 설정 UI의 세 모드를 연결한다. `IrAirpurifier`는 같은 버튼 요청만 확인되고 실제 전원 상태·realtime 피드백 계약이 부족해 절대 Switch로 확장하지 않는다. 모드는 설정값이며 실물 운전 모드 확인은 아니다. 풍량·필터·리셋은 제공하지 않는다. |
| B10 도어락 문 열림 | `map:components/dashboard/liveEvent.js:228-236`은 `SmartDoorLock`/`ZigbeeDoorlock`의 `door_opened`→`doorOpened`를 수신한다. 목록은 **`ZigbeeDoorlock`**에서 `doorOpened===false`를 닫힘, 그 외를 열림으로 표시한다(`map:components/dashboard/DeviceItem.js:450-453`). | `ZigbeeDoorlock`의 strict boolean `doorOpened`만 읽기 전용 ContactSensor로 매핑한다. `true`는 문 열림, `false`는 닫힘, 결측/null/문자열·숫자는 unknown이다. 공급자 화면의 비-`false`→열림 fallback을 복제하지 않는다. `state:'OPEN'` 같은 다른 필드로 fallback하지 않으며, 문 개폐는 잠금 볼트 상태가 아니므로 LockMechanism·unlock 명령은 제공하지 않는다. `SmartDoorLock`은 타입별 표시 의미가 확인될 때까지 보류한다. |

## 공기질 농도 보정 계약

공개 Web의 `pm25` 필드 존재는 확인했으나 API가 µg/m³인지, 모델별 배율이 무엇인지는 확인되지 않았다. 따라서 자동 단위 추정이나 자동 공기질 등급을 하지 않는다. 사용자가 **해당 Airpurifier에만** `pm25Multiplier`라는 양수 유한 배율을 명시할 때 `src/devices/airQuality.ts`의 `calibratePm25(raw,multiplier)`로 0–1000 µg/m³를 계산한다. 원본 0은 유효하며, 결측·빈 문자열·비수치·음수·범위 밖은 null이다. 농도 표시 전에는 runtime의 `getMeasurementHealth(id,'pm25')`로 최근 보고를 확인한다. 초기 REST snapshot은 새 측정 시각의 증거가 아니다. `src/runtime/health.ts`의 PM2.5 기본 90분 만료는 로컬 정책이며 제품 보고 주기를 보증하지 않는다; 설정한 `freshnessMinutes`가 있으면 그 값을 쓴다. HAP AirQuality 등급은 기준이 별도 검증될 때까지 UNKNOWN, 정화 풍량과 필터 특성은 미노출한다.

## 구현과 검증 경계

`src/devices/capabilities.ts`는 `Airpurifier`만 partial Switch, `ZigbeeDoorlock`만 partial ContactSensor로 분류한다. `src/devices/purifier.ts`의 `encodePurifierControl`은 정확히 한 `power:boolean` 또는 `mode:'auto'|'manual'|'sleep'` 필드만 허용하고, `decodePurifierSettings`는 공급자 초기 REST의 boolean/`'true'`/`'false'` 전원과 세 모드만 알려진 값으로 반환한다. `src/hej/realtime.ts`는 `switch`의 문자열 false를 꺼짐으로 정규화하고 `door_opened`는 boolean 외 null로 만든다. HAP/Matter의 각 서비스는 상태 미수신을 정상 상태로 바꾸지 않아야 한다.

`Airpurifier`는 내부에서 릴레이형 전원 서비스를 재사용하지만 조명·콘센트·스위치 역할 변경 대상은 아니다. `supportsDeviceRole(deviceType)`은 기존 물리 스위치·릴레이·플러그·멀티탭의 역할 변경을 유지하고 Airpurifier를 제외한다. 설정 UI와 HAP는 이 판정을 공통으로 사용한다. 장치 분류용 `serviceKind`를 사용자에게 임의 역할 선택 권한으로 해석하지 않는다.

이 문서는 공개 계약으로 구현 가능한 범위와 미확정 범위를 분리한다. 현재 등록 장비 목록에는 B1/B4/B5/B6/B10 대상이 없으므로 물리 버튼 횟수, 레이더 부재 전환, 커튼 정지·각도, 공기청정기 모드/PM2.5 단위, 도어락 개폐를 실기에서 판정하지 않았다. 모델별 redacted 원본 report와 사용자 조작 시각, 공급자 앱 표시, 명령 ACK, 실제 동작/자동화 횟수를 같은 시간축에서 확인해야 남은 완료 조건을 닫을 수 있다.
