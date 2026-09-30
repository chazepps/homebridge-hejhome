# 미디어·보안 장비 계약 (3.0.0-beta.1)

2026-09-30 공개 [Hejhome Web](https://square.hej.so/) 동작과 이 저장소 코드를 대조했다. 공급자 계정·실물 장치·영상에 접속하지 않았으므로 웹 클라이언트의 요청 형식과 실제 장치 동작을 구분한다.

| 항목 | 현재 구현 | 남은 검증 |
| --- | --- | --- |
| B8 TV·IR 리모컨 | `IrTv`/`IrSettopbox`의 소리·채널 올림/내림과 음소거 켜기/끄기, `IrFan`의 풍속·회전 버튼을 엄격히 검증한다. 설정 화면은 이 명령과 숫자 채널 0–999를 보낸다. 기기별 `remoteButtons`를 켜면 **같은 Home 액세서리**에 TV/셋톱 6개 또는 선풍기 2개의 순간 `Switch` 버튼이 추가된다. 기본값은 꺼짐이다. | 실제 모델의 반복 입력·음량 한계·IR 동작과 외부 리모컨 피드백. 입력 선택·재생 상태·절대 전원 상태는 확인되지 않아 `Television`/Matter media 장치로 표시하지 않는다. |
| B9 카메라 | 카메라 목록, WebRTC 설정, access-config를 읽는 REST 경로가 있다. 별도 `CameraSignallingSession`은 응답 필드, MQTT offer/answer/ICE/disconnect, 세션 일치, 크기 제한, 취소·정리를 합성 테스트로 검증한다. | 실제 인증 MQTT transport와 Node WebRTC peer, 영상→HAP RTP 및 JPEG snapshot, 실기 코덱·권한·동시 접속. **현재 사용자에게 카메라를 노출하지 않는다.** |
| B10 도어락·경보 | `ZigbeeDoorlock`의 `doorOpened`만 읽기 전용 `ContactSensor`로 표시한다. true는 열림, false는 닫힘, 다른 값은 알 수 없음이다. | 문 접점은 잠금 볼트 상태가 아니다. 잠금/해제 명령·걸림·권한, 사이렌 상태와 경계/해제 상태는 확인되지 않아 제어를 제공하지 않는다. |

## 확인된 공급자 흐름

웹 TV/셋톱 리모컨은 `dashboard/control/{id}`의 `requirments`에 `volume:'up'|'down'`, `channel:'up'|'down'`, `setChannel:number`, `mute:boolean`을 넣는다. 선풍기 풍속·회전은 각각 `fanSpeed:true`, `swing:true` 버튼 펄스다. 피드백 없는 IR 전원도 `power:true` 펄스일 수 있으므로 REST 성공을 확정된 켜짐 상태로 저장하지 않는다. HAP 순간 버튼은 [Homebridge Switch 서비스](https://developers.homebridge.io/HAP-NodeJS/classes/_definitions.Services.Switch.html)를 사용하며 전원 서비스와 액세서리 ID를 유지한다.

웹 카메라는 프로필 uid → 별도 카메라 목록 → 장치 WebRTC 설정 → access-config 생성 → MQTT over WebSocket 신호 교환 → 브라우저 영상 track 순서로 동작한다. access-config에는 `uid`, 카메라 `unique_id`, `link_type:'websocket'`, `topics:'ipc'`가 들어간다. 공개 화면에서 별도 snapshot/JPEG 경로는 확인되지 않았다. 현재 signalling 모듈은 인증된 전송과 peer를 **주입받는 독립 코드**이며 runtime·Home 앱과 연결되지 않았다. 공개 웹의 broker 로그인 자료와 access-config의 세션 payload 자료는 별개다. broker 자격정보의 정식 공급 경로는 확인되지 않았고 상수를 복사하거나 서로 대체하지 않았다. 새 WebRTC/FFmpeg 패키지도 추가하지 않았다.

[HAP 카메라 delegate](https://developers.homebridge.io/HAP-NodeJS/interfaces/CameraStreamingDelegate.html)는 JPEG snapshot과 준비·시작·종료되는 RTP 영상이 필요하다. [Werift](https://github.com/shinyoshiaki/werift-webrtc)와 [HAP 공식 카메라 예제](https://github.com/homebridge/HAP-NodeJS/blob/latest/src/accessories/Camera_accessory.ts)는 Node 미디어 파이프라인 구현 경로를 보여주지만 Hejhome 호환성을 증명하지 않는다. HKSV는 별도의 [녹화 delegate](https://developers.homebridge.io/HAP-NodeJS/interfaces/CameraRecordingDelegate.html), 프리버퍼·분할 미디어·모션 트리거 및 실제 이벤트 재생 검증이 필요하다.

공개 웹의 경보 시험 명령과 문 열림 표시는 보안 시스템의 경계/해제 또는 잠금 명령과 다르다. 실제 모델별 상태 재수신 전에는 `LockMechanism`·Matter DoorLock·SecuritySystem 제어를 추가하지 않는다.
