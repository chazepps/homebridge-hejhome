# Login Config UI Spec

## Goal

Allow a Homebridge user to authenticate with Hejhome Web from the plugin settings modal without storing a password.

## Flow

1. User enters email or phone identifier.
2. User requests a verification code.
3. UI waits for code entry.
4. UI submits code verification.
5. UI enables password field only after verification succeeds.
6. User enters password.
7. UI submits login with auto-login fixed on.
8. UI stores non-password session material and updates plugin config.

## Acceptance

- Password is disabled until verification succeeds.
- Login is disabled until password is present.
- Auto-login is checked and cannot be unchecked.
- Request order is send, verify, login.
- Password is not persisted in config or session storage.
