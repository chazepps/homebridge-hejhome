# Quality Score

## Current Score

| Area | Score | Evidence |
| --- | ---: | --- |
| Official Homebridge shape | 4/5 | Metadata and schema tests exist |
| Authentication flow | 4/5 | Mocked auth tests and UI sequence test exist |
| Runtime device model | 3/5 | Foundational switch/light mapping exists; broader device types remain future work |
| Security hygiene | 4/5 | Redaction and storage tests exist |
| CI readiness | 4/5 | Actions planned and wired into docs gates |

## Remaining Risks

- Hejhome realtime protocol still needs direct authenticated browser capture to confirm all message variants.
- Device capability mapping is intentionally conservative until more device payloads are captured.
