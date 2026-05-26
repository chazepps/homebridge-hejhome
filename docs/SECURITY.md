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
