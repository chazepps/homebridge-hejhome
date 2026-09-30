# Hejhome과 Homebridge Smart Automation 시험 가이드

이 문서는 **시험용 Homebridge**에서 Hejhome 장치를 Smart Automation에 연결할 때 사용하는 설정 예시입니다. 검증 기준은 Hejhome 플러그인 `2.1.0-beta.1`, Homebridge core `2.4.0`의 로컬 HAP 출력, Homebridge UI `v6.0.1-alpha.20`의 [공식 소스 `b85d97ff`](https://github.com/homebridge/homebridge-config-ui-x/tree/b85d97ff3777c6f72a451db9ba8c16bd530fab42/src/smart-automation)입니다. 플러그인 베타, core 베타, UI 알파는 서로 다른 버전 축입니다. 이 문서의 자동화 실행 검증은 **공식 규칙 소스의 격리 실행**이며 UI 알파 화면이나 실물 장치에서의 성공을 뜻하지 않습니다. UI 알파 [릴리스](https://github.com/homebridge/homebridge-config-ui-x/releases/tag/v6.0.1-alpha.20)는 운영 사용을 권장하지 않습니다.

## 시작하기 / Getting started

1. 운영 브리지와 분리된 시험용 Homebridge에 Hejhome 플러그인 베타와 UI 알파를 설치하고, 각 버전을 따로 기록합니다. core 베타를 시험한다면 core 버전도 따로 기록합니다. 이 가이드의 로컬 HAP 검증에는 core `2.4.0`을 사용했습니다.
2. Hejhome 장치가 **HomeKit/HAP에 표시**되는지 먼저 확인합니다. UI 알파의 Smart Automation은 HAP 장치를 `uniqueId`로 발견하고 상태 이벤트를 감시합니다. Matter에만 표시되는 장치는 이 규칙의 입력으로 확인되지 않았습니다.
3. UI의 Smart Automations에서 규칙 종류와 장치를 선택합니다. 선택 목록이 실제 HAP 서비스의 `uniqueId`를 저장하므로 장치 ID를 손으로 추측하지 마세요. 아래 JSON은 필드 의미를 설명하는 **예시**입니다.
4. 규칙을 저장하면 UI가 Smart Automations 자식 브리지 설정을 기록하고 그 자식 브리지의 재시작을 요청합니다. 저장 직후 규칙이 실행되는지 자식 브리지 로그와 HAP 상태로 확인합니다. 사용자 알림은 별도의 Home 앱/컨트롤러 자동화 또는 알림 설정으로 확인해야 합니다.

규칙은 UI의 `smart-automation` 플랫폼 설정에 `smartAutomations` 배열로 저장됩니다. 예시의 `HAP-...` 값은 실제 장치 선택으로 대체합니다. `Hejhome` 플랫폼 설정에 붙여넣는 값이 아닙니다.

## 자동제어에 사용하기 전 확인해야 할 사항 / Before enabling control

- **현재 상태 확인:** 문·모션·온습도 값이 실제 장치 앱과 일치하는지 보고, 장치를 끊었을 때 HAP 읽기가 통신 오류와 오류 상태로 바뀌는지 확인합니다. UI 알파의 문·습도 규칙은 마지막 값이 남아 있으면 그 값을 사용할 수 있습니다.
- **명령 결과 확인:** 규칙이 켜거나 끈 뒤 실제 조명·스위치·에어컨 상태가 맞는지 확인합니다. 클라우드 명령 실패와 반복 이벤트에서 의도하지 않은 재시도가 생기지 않는지도 봅니다.
- **알림 경로 확인:** 가상 문 센서와 가상 보안 상태만으로 사용자 알림이나 물리 경보가 보장되지 않습니다. Home 앱/컨트롤러 자동화, 수신 기기, 실제 알림을 각각 확인합니다.
- **제한된 사용:** 아래의 단절·오래된 값·재시작 시험을 통과하지 않은 규칙은 무인 제어 또는 실제 보안 대응에 사용하지 않습니다.

```json
{
  "platform": "smart-automation",
  "name": "Smart Automations",
  "smartAutomations": [
    { "id": "test-light", "name": "거실 조명", "type": "smart-light-group", "uniqueIds": ["HAP-RGB", "HAP-WHITE"], "lightbulbType": "on-off", "enabled": true },
    { "id": "test-door", "name": "현관 문 오래 열림", "type": "door-ajar", "uniqueIds": ["HAP-CONTACT"], "openMinutes": 5, "repeatMinutes": 10, "enabled": true },
    { "id": "test-humidity", "name": "습도 환기", "type": "humidity-control", "uniqueIds": ["HAP-HUMIDITY"], "targetUniqueId": "HAP-SWITCH", "onHumidity": 65, "offHumidity": 55, "enabled": true },
    { "id": "test-temperature", "name": "방 평균 온도", "type": "average-temperature", "uniqueIds": ["HAP-TEMP-1", "HAP-TEMP-2"], "removeAfterMinutes": 30, "enabled": true },
    { "id": "test-security", "name": "출입 감시", "type": "security-system", "uniqueIds": ["HAP-CONTACT", "HAP-MOTION"], "autoBypass": false, "enabled": true }
  ]
}
```

## C1. 조명 그룹 / Light group

Hejhome RGB/RGBW 조명은 HAP `On`, `Brightness`, `Hue`, `Saturation`을, 백색 조명은 `On`, `Brightness`, `ColorTemperature`를 제공합니다. 그룹의 표시 타입은 `on-off`, `dimmable`, `colour`, `temperature` 중 선택합니다. 능력이 다른 조명을 섞으면 공통 기능인 `on-off`가 안전한 예시입니다. 공식 규칙은 각 조명의 **쓰기 가능한 특성만** 전달하며, 개별 장치 쓰기 실패는 기록하고 다음 장치로 진행합니다. 그룹을 켤 때 기존 값을 저장하고 끌 때 그 값을 복원하므로 그룹 `Off`가 항상 모든 조명을 끄는 뜻은 아닙니다. 개별 조명 변경이 가상 그룹의 표시 상태로 역반영되는 기능은 공식 알파 소스에서 확인되지 않았습니다.

시험에서는 가상 그룹을 켜고 각 조명의 전원을 확인한 뒤 밝기·색·색온도를 해당 모델에서만 조작하세요. 조명 하나를 오프라인으로 만들었을 때 다른 조명의 한 번 조작이 완료되는지, 실패한 조명에 재전송이 계속되는지 자식 브리지 로그와 실제 상태로 확인합니다. 한 장치를 직접 조작했을 때 가상 그룹 표시가 따라오리라고 기대하지 마세요.

## C2. 문 오래 열림 / Door left ajar

Hejhome 문 센서 `SensorDo`의 HAP `ContactSensor`를 하나 고릅니다. `openMinutes: 5`는 5분 이상 열려 있을 때 가상 문 센서를 열림으로 바꿉니다. `repeatMinutes: 10`은 문이 계속 열려 있으면 가상 센서를 잠시 닫았다 다시 여는 반복 신호입니다. 문이 닫히면 타이머와 반복 신호가 취소됩니다. 이 규칙은 알림을 직접 전송하지 않습니다. 알림을 원하면 가상 문 센서가 열릴 때 알리도록 Home 앱/컨트롤러에서 설정하고 실제 알림 도착을 별도로 확인하세요.

시험에서는 5분 전에는 신호가 없고 5분 후 한 번 열림이 발생하는지, 닫았다 다시 열면 시간이 새로 시작하는지, 재시작 뒤 상태를 다시 읽는지 확인합니다. 센서 단절은 열린 문과 구분해야 합니다. **알파 규칙은 `StatusFault`와 값의 나이를 검사하지 않아** 마지막 열림값이 남아 있으면 단절 중에도 알림이 발생할 수 있습니다. 이 조건을 실기에서 통과하기 전에는 안전·보안 용도로 사용하지 마세요.

## C3. 습도 제어 / Humidity control

Hejhome `SensorTh`, `SensorTh2`, `SensorRefTh`, `SensorRefTh2`의 HAP `HumiditySensor` 하나와 쓰기 가능한 `Switch` 또는 `Outlet` 타깃 하나를 고릅니다. 예시 `onHumidity: 65`, `offHumidity: 55`는 **65% 초과**에서 켜고 **55% 미만**에서 끕니다. 55–65% 구간과 정확히 55%, 65%에서는 현 상태를 유지합니다. 타깃으로 IR 에어컨을 선택할 경우 HAP `Thermostat`의 `TargetHeatingCoolingState`를 제어하므로 실제 냉방/꺼짐 의미와 B3 제어 검증이 끝난 모델에서만 사용합니다.

시험에서는 65→66→60→55→54% 순서로 타깃 상태를 확인하고, 중간 구간에서 수동으로 바꾼 타깃이 유지되는지 확인합니다. 임계 범위 밖에서 수동 조작하면 다음 센서·타깃 이벤트에 규칙이 다시 적용될 수 있습니다. 클라우드 명령 실패 뒤 재시도 횟수와 실제 전원도 확인하세요. **알파 규칙은 센서 `StatusFault`/신선도를 검사하지 않습니다.** 마지막 습도값이 남는 단절에서는 오동작 가능성이 있으므로 실기에서 이를 배제하기 전까지 무인 제어에 사용하지 마세요.

## C4. 평균 온도 / Average temperature

`TemperatureSensor`의 **실측 `CurrentTemperature`**만 선택합니다. 에어컨 목표 온도 `TargetTemperature`는 평균에 포함하지 않습니다. UI는 실측값이 있는 `Thermostat`도 선택할 수 있지만, Hejhome IR 에어컨의 실내 실측값은 별도 검증된 온도 센서에 연결된 경우만 사용하세요. 예시 20°C와 24°C의 결과는 22°C입니다. 단위를 섞지 말고 두 센서 모두 °C인지 확인합니다.

`removeAfterMinutes: 30`은 공식 규칙에서 마지막 **성공한 실측값 읽기** 이후의 만료 기준입니다. 일부 센서의 새 읽기가 실패하면 그 센서를 제외하고 나머지만 평균냅니다. 모두 실패하면 새 평균은 발행되지 **않지만, 가상 온도 센서에 이전 값이 남습니다.** 유효한 센서가 없을 때 그 표시값을 현재 온도로 사용하지 마세요. 시험에서는 두 값의 수동 평균, 한 센서 단절, 모두 단절, 재연결 후 값 갱신을 비교합니다. Hejhome의 A1 실측 신선도 판정과 B3의 실측/설정온도 분리를 먼저 확인해야 합니다.

## C5. 문·모션 보안 / Contact and motion security

Hejhome `SensorDo` 및 `SensorMo`의 HAP 서비스를 선택합니다. `autoBypass: false`이면 열린 문이 있는 동안 경계 요청을 거부하고 가상 보안 서비스에 오류를 표시합니다. `true`이면 경계 시 이미 열린 문을 닫힐 때까지 제외하고, 닫힌 다음 다시 열리면 경보 상태가 됩니다. 경계 시 감지 중인 모션은 자동으로 제외되고 감지가 해제되면 보호 대상으로 돌아옵니다. 해제하면 경보 상태가 초기화됩니다.

이 기능은 **가상 보안 상태**를 발행합니다. Hejhome 사이렌, 잠금장치, 경찰·사용자 통보를 직접 제어한다는 뜻이 아닙니다. 가상 보안 상태를 다른 자동화의 입력으로 사용한다면 실제 알림 도착까지 따로 시험하세요. 경계 중 문·모션 이벤트, 해제 후 이벤트, bypass한 문이 닫힌 뒤 다시 열리는 순서를 확인합니다. **알파 규칙은 선택한 센서가 발견되지 않아도 경계를 허용**하며 `StatusFault`도 입력 판정에 사용하지 않습니다. 센서 단절·자식 브리지 재시작에서 이 제한을 확인하기 전에는 실제 보안 시스템으로 취급하지 마세요.

## 검증 기록 / Test record

현재 완료된 증거는 두 가지입니다. 저장소의 `tests/automation-hap.test.ts`는 Homebridge core `2.4.0` HAP 객체에서 Hejhome 서비스·특성·상태 이벤트·쓰기·실패 읽기를 확인합니다. `node tools/automation/verify-upstream.mjs`는 공식 UI 알파 태그의 규칙 소스를 SHA 확인 뒤 임시 디렉터리에서 그대로 실행해 C1–C5의 동작과 위 제한을 재현합니다. 이 테스트는 운영 서비스를 시작하거나 설정을 쓰지 않습니다. 실제 UI 화면/자식 브리지 시작, 실물 Hejhome 센서와 액추에이터, 알림 수신, UI 정식 버전 회귀는 별도 현장 검증 항목입니다.

실기 기록에는 각 축의 정확한 버전, 선택한 장치명과 HAP 서비스, 시험 시각, 앱에서 본 원래 값, 가상 장치 상태, 실제 명령 결과, 알림 도착 여부를 함께 남기세요. 실패한 경우 장치나 규칙의 `uniqueId`와 해당 시각의 자식 브리지 로그를 비교합니다. 운영 브리지 설정이나 계정 비밀은 기록에 포함하지 않습니다.
