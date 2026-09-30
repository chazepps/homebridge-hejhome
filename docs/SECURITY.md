# Security

## Secrets

The plugin handles password, verification code, session cookie value, encoded username cookie, access token, and authorization headers. Only session material needed for Homebridge runtime is persisted.

## Storage

Session files are written under the Homebridge storage directory through `api.user.storagePath()` or the UI server storage path. The repository, temp folders, and working directory are not used for persistent secrets.

## Logging

`src/utils/redact.ts` masks token, cookie, password, authorization, and email-like values. Documentation validation also rejects raw sensitive patterns.

## UI Security

The custom UI keeps auto-login fixed on and does not expose a password persistence option. Passwords are submitted only to the login endpoint and are not written into Homebridge config.

## Release Security

GitHub Actions use least-necessary permissions. npm publishing is designed for Trusted Publishing with provenance instead of long-lived npm tokens.

## 3.0 beta local command boundary

The settings process sends validated high-level requests to the running plugin through a local Unix socket. Runtime revalidates the canonical device type and encodes only verified commands before entering the shared device queue. The private directory/socket use restricted permissions; requests have size and lifetime limits, duplicate request identifiers are rejected, and callers never automatically retry an uncertain physical command. No cloud credentials travel in this protocol. Active endpoints owned by another process are preserved. Windows and overlong socket paths disable only this new UI control channel.

Diagnostics export omits account credentials, device identifiers and user-assigned names. Unrecognized/deferred device classes are retained for diagnostics without inventing control services. Internal agent work records and generated npm archives are excluded from public documentation inventory and package file lists.
