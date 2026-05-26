# Hej Web Packet Map

## Confirmed

| Flow | Endpoint Pattern | Notes |
| --- | --- | --- |
| Email verification send | `2factor.goqual.com` email send path | Captured from Hejhome Web traffic and stored only as redacted flow |
| Password login | `square.hej.so` OAuth login path | Uses request-time OAuth authorization headers |
| Authorization code | `square.hej.so` OAuth authorize path | Auto-login cookie state is included |
| Token exchange | `square.hej.so` OAuth token path | Access token is parsed and persisted through `SessionStore` |

## Inferred

| Flow | Reason |
| --- | --- |
| Phone verification send | Same service family as email verification; requires direct captured request before marking confirmed |

## Rule

Do not copy raw packet bodies into documentation. Record only redacted endpoint families, request order, and field purpose.
