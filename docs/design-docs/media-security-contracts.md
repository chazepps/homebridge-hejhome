# 미디어·보안 장비 연동 계약 (B8–B10)

2026-09-30 조사 기준. 이 문서는 구현과 실기 확인을 구분한다. Hejhome 계정 로그인, 장치 제어, 카메라 접속은 수행하지 않았다. 공개 웹 번들의 필드·호출 순서만 요약했으며 공급자 코드는 저장소에 복사하지 않았다. 공개 번들이 현재 계정·펌웨어·모델에서 그대로 동작한다는 증거는 아니다.

## 확인한 자료와 현재 구현

| 근거 | 확인된 내용 | 한계 |
| --- | --- | --- |
| `src/devices/capabilities.ts`, `src/platformAccessory.ts`, `src/platform.ts` | IR TV 계열은 `Switch`의 `power` 제어만 사용한다. REST 응답 뒤 요구값을 장치 상태에 반영한다. 카메라는 deferred, 잠금·사이렌 계열은 partial/unsupported이다. | REST 성공은 물리 동작·현재 상태의 확인이 아니다. |
| `src/hej/rest.ts`, `src/hej/realtime.ts` | 카메라 목록·WebRTC 설정·access-config 경로가 있고 반환형은 구조가 확인되지 않은 값이다. `alarm_switch`, `alarm_state`를 각각 boolean으로 축약한다. | 카메라 signalling/영상 전송, 잠금 볼트 상태, 경보 모드 구분은 없다. |
| [Hejhome 공개 웹 번들 소스맵](https://square.hej.so/static/js/main.5819c1ee.chunk.js.map) | TV 리모컨, 카메라 연결, AudibleAlarm 화면이 사용하는 필드와 순서가 노출되어 있다. | 정적 클라이언트 코드의 호출 의도만 확인된다. 서버 수락·응답·실물 결과는 확인하지 않았다. |
| [Homebridge API](https://developers.homebridge.io/homebridge/interfaces/API.html), [CameraController options](https://developers.homebridge.io/HAP-NodeJS/interfaces/CameraControllerOptions.html) | 외부 액세서리 공개 API와 카메라 streaming/recording delegate 계약이 있다. | Hejhome 장치의 지원 능력을 증명하지 않는다. |

## B8 TV·오디오·IR 리모컨

공개 웹 UI는 `IrTv`, `IrSettopbox`에 대해 `dashboard/control/{id}`의 `requirments`에 다음 값을 보낸다. `volume: 'up'|'down'`, `channel: 'up'|'down'`, `setChannel: number`, `mute: boolean`. 숫자 채널은 웹 UI에서 최대 세 자리를 모아 약 800ms 후 전송한다. 한 자리 `0`도 UI에서 입력할 수 있다. 이것은 웹 클라이언트의 키 계약이다. 연속 입력을 서버가 어떻게 처리하는지, 볼륨 한계와 현재 음량, 음소거 피드백, 채널·입력 상태는 확인되지 않았다. `IrSpeaker`에 같은 패널이 연결된 근거도 없다.

같은 공개 UI의 `IrFan` 패널은 회전과 풍속 클릭 때 각각 `swing: true`, `fanSpeed: true`를 보낸다. 둘 다 버튼 펄스이며 목표 회전 상태나 풍속 단계가 아니다. `src/media/irRemoteCommands.ts`는 이 두 명령과 위 TV/셋톱 키만 엄격히 검증하고, 전송 함수에 요구값만 전달한다. 전원·입력·재생 명령이나 낙관적인 현재 상태는 만들지 않는다. 테스트는 잘못된 모델/명령/채널과 전송 오류를 검증한다.

웹 UI는 IR 장치에 읽을 수 있는 전원 상태가 없을 때 `power: true` 펄스를 보낸다. 따라서 현재 HAP `Switch`의 `On`을 절대 켜짐/꺼짐으로 해석하고 REST 응답 후 상태를 확정하는 경로는 IR TV에서 실제 상태를 보장하지 못한다. 모델별 절대 전원 명령과 토글 여부가 확인되기 전에는 `Television.Active`를 현재 상태로 제공할 수 없다.

`Television`, `InputSource`, `TelevisionSpeaker`는 실제 입력 목록, 선택값, 음량·음소거 및 버튼 의미가 각각 검증된 모델에만 붙인다. 현재 확인된 네 종류의 리모컨 필드만으로 입력 전환·방향키·재생 상태를 만들어서는 안 된다. TV를 별도 HAP 액세서리로 전환할 때는 [Homebridge의 별도 페어링 안내](https://developers.homebridge.io/homebridge/index.html)에 맞춰 고정 UUID, 새 QR 페어링, 기존 브리지 액세서리 캐시 정리, 제거 및 이전 매핑 복구 절차를 먼저 정한다. `publishExternalAccessories`는 API에 있지만 기존 `registerPlatformAccessories`와 달리 독립 페어링이 필요하다.

다음 검증 단위: 모델·펌웨어별 요청/응답과 물리 동작을 1:1로 기록하고 `volume` 연타, `channel` 연타·숫자 입력, mute on/off, 외부 리모컨 조작, 실패·타임아웃 뒤 상태 재수신을 확인한다. 그 뒤 검증된 키만 명령 변환기와 HAP 서비스에 연결한다. Matter media type은 실제 장치 상태·명령과 Homebridge 지원 유형을 함께 확인한 다음 결정한다.

## B9 카메라 미리보기·실시간 영상·HKSV

공개 웹 UI의 호출 순서는 사용자 프로필의 uid 확인 → 별도 카메라 목록 → 장치별 WebRTC 설정 → `access-config` 생성 → MQTT over WebSocket signalling → 브라우저 `RTCPeerConnection` 영상 track 수신이다. `access-config` 요청은 `uid`, 카메라 `unique_id`, `link_type: 'websocket'`, `topics: 'ipc'`를 사용한다. 설정의 ICE 서버와 auth, access-config의 source/sink IPC topic과 연결 권한을 signalling에 이용한다. offer·answer·ICE candidate·disconnect가 세션 단위로 교환된다. 공개 UI는 video 수신만 요청하고 `MediaStream`을 `<video>`에 붙인다. 서버 응답 구조, 토큰 수명, 실제 코덱·해상도·오디오·동시 시청자 한도는 확인되지 않았다. 공개 UI에서 스냅샷 API 또는 JPEG 생성 경로도 확인되지 않았다.

[HAP streaming delegate](https://developers.homebridge.io/HAP-NodeJS/interfaces/CameraStreamingDelegate.html)는 크기를 맞춘 JPEG snapshot, 스트림 준비, 스트림 시작·종료를 처리해야 한다. 브라우저 영상이 보인다는 사실만으로 HAP RTP/RTCP 전송이 생기지 않는다. 필요한 구현은 인증·권한 갱신, 세션별 signalling과 ICE, WebRTC 수신→HomeKit 호환 미디어 변환, snapshot 생성, 취소·단절·재인증·재연결, 동시 시청 제한, 종료 시 프로세스·소켓 해제이다. 영상 세션 자격 증명은 일반 장치 제어·로그·저장된 상태와 분리한다.

HKSV는 별도 완료 단위다. [HAP recording delegate](https://developers.homebridge.io/HAP-NodeJS/interfaces/CameraRecordingDelegate.html)는 선택된 recording configuration, 활성화 상태, prebuffer, 초기화 packet과 keyframe으로 시작하는 분할 MP4, motion event, stream 종료·ack 처리를 요구한다. [recording options](https://developers.homebridge.io/HAP-NodeJS/interfaces/CameraRecordingOptions.html)의 prebuffer 하한도 충족해야 한다. 실제 카메라·Home 앱·홈 허브에서 이벤트 녹화와 재생을 검증해야 한다. `CameraController` 생성만으로 이 조건을 충족하지 않는다.

다음 검증 단위: 권한 있는 테스트 카메라의 redacted 응답 schema, 연결 성공 SDP 코덱, snapshot 가능 여부, 오디오, 세션 만료, 연결 취소, 장시간 동작, 여러 뷰어를 수집한다. snapshot/실시간 HAP 성공과 HKSV 녹화·재생 성공을 별도 증거로 남긴다.

## B10 도어락·사이렌·경보

공개 웹 목록의 `ZigbeeDoorlock`은 `doorOpened`를 열림/닫힘으로 표시한다. 이것은 문 개폐 정보이며 잠금 볼트의 잠김·열림·걸림 상태라는 근거가 아니다. 목록에서 도어락 패널은 열지 않고, 잠금/해제 제어 명령도 확인되지 않았다. 따라서 `LockMechanism`의 current/target state 또는 Matter DoorLock으로 변환할 수 없다. `SmartDoorLock`도 화면 아이콘·모델명 이외에 명령 계약이 없다.

공개 `AudibleAlarm` 패널은 `alarmVolume`의 `mute`/`low`/`medium`/`high` 선택, `alarmSwitch` 감지 표시와 최근 시각을 사용한다. “울려보기”는 `alarmVolume`과 `alarmSwitch: true`를 함께 보내는 시험 명령이다. 이는 상시 사이렌 on/off, 보안 시스템 경계/해제, 실제 침입 경보 상태를 뜻하지 않는다. 별도 `Siren` 모델에 같은 명령이 통한다는 근거도 없다. 현재 realtime의 boolean 축약은 원래 값과 장치 유형을 잃어 이 구분을 할 수 없다. [HAP SecuritySystemCurrentState](https://developers.homebridge.io/HAP-NodeJS/classes/_definitions.Characteristics.SecuritySystemCurrentState.html)의 armed/disarmed/alarm 상태에 단순 `alarm` boolean을 대응시키지 않는다.

다음 검증 단위: 모델별 원본 상태값·시간축·물리 조작·재시작 결과를 확보하고, `doorOpened`와 볼트 상태, siren 발생 여부와 경계 모드, command ACK와 상태 재수신을 분리한다. 읽기 전용 센서도 `unknown`을 정상 상태로 바꾸지 않고 응답 불능으로 표시할 수 있어야 한다. 쓰기는 사용자의 원격 제어 권한, 반대 명령 경합, 응답 없음과 실패 시 상태 유지, 실제 상태 재수신을 검증한 모델에 한정한다.

## 이번 조사 결과

공개 소스맵으로 B8의 TV/셋톱박스 리모컨 필드와 IrFan 버튼, B9의 브라우저 signalling 흐름, B10의 경보 시험 명령을 추가 확인했다. 검증 가능한 IR 명령 변환기·전송 dispatcher를 구현했다. 그러나 이 브랜치에는 해당 장치의 서버 응답·실기 상태·미디어 샘플이 없다. 따라서 HAP/Matter의 supported 표시, CameraController 틀, 잠금/경보 제어는 이번 증거만으로 구현하지 않는다. 서비스 연결과 B8 완료 판정은 모델별 수락·물리 동작 확인 뒤에 한다.
