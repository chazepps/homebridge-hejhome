# Hej Auth Session

## Authentication Boundary

`HejAuthClient` owns verification sending, verification confirmation, password login, authorization code exchange, and token response parsing.

## Session Boundary

`SessionStore` persists only session data needed for runtime API calls. Password and verification code are excluded by type and by test.

## UI Server Boundary

The UI server keeps an in-memory set of identifiers that have completed verification in the current settings session. Password login is rejected if verification has not completed first.

## Open Protocol Item

The email verification endpoint is confirmed from captured traffic. Phone verification should remain marked as inferred until a separate captured request confirms it.

## 3.0 session replacement

Runtime watches the stored session after login as well as before login. A changed session starts a new generation, cancels old HTTP requests and queued work, clears old-account verification, and reconnects. A failed new discovery cannot authorize the previous account's cached devices. This is session replacement and recovery, not an undocumented refresh-token implementation. Login UI/API request order remains unchanged.
