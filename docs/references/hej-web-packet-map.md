# Hej Web Packet Map

## Confirmed

| Flow | Endpoint Pattern | Notes |
| --- | --- | --- |
| Email verification send | `2factor.goqual.com` email send path | Captured from Hejhome Web traffic and stored only as redacted flow |
| Password login | `goqual.io` OAuth login path with `vendor=openapi` | Uses request-time Basic authorization and an empty JSON body |
| Authorization code | `goqual.io` OAuth authorize path | Session cookie from login is included; `redirect_uri` is `square.hej.so/list` and scope is `shop` |
| Token exchange | `goqual.io` OAuth token path | Uses the same `redirect_uri` as authorize; access token is persisted through `SessionStore` |
| Device list | `goqual.io` OpenAPI devices path | Homes and rooms are derived from the device list when family endpoints are absent |
| Device command | `goqual.io` OpenAPI control path | Body contains `requirments`, matching the upstream spelling |

## Inferred

| Flow | Reason |
| --- | --- |
| Phone verification send | Same service family as email verification; requires direct captured request before marking confirmed |

## Rule

Do not copy raw packet bodies into documentation. Record only redacted endpoint families, request order, and field purpose.
