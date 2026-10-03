# Homebridge Official Rules

## Required Shape

- Plugin type: dynamic platform.
- Package name starts with `homebridge-` or scoped equivalent.
- Main entrypoint is `dist/index.js`.
- `type` is `module`.
- Platform registration uses `api.registerPlatform`.
- `config.schema.json` sets `pluginType` to `platform`.
- `pluginAlias` matches `PLATFORM_NAME`.
- `customUi` is enabled.
- `singular` is enabled.

## Verification Readiness

- Declare every supported transport in `keywords`: v2 uses `supports-hap`; v3 uses both `supports-hap` and `supports-matter`.
- Use standard JSON Schema: `required` is an array on the containing object, never a boolean on a property.
- Keep Homebridge and HAP-NodeJS out of runtime, peer, and bundled dependencies; the host supplies them.
- Ship built entrypoints, the custom UI server and page, schema, and branding in the npm package. Installation must not depend on a local development build.
- Keep the release tag, package version, lockfile version, and intended npm channel consistent. Stable and beta source branches must remain distinguishable.
- Check supported Node 22/24 environments and retain each release line's documented minimum. Extra Node 26 tests do not replace LTS checks.

## Runtime Rules

- Restore cached accessories in `configureAccessory()`.
- Register or unregister accessories only after `didFinishLaunching`.
- Persist plugin files below Homebridge storage.
- Avoid postinstall scripts, tracking calls, and unhandled exceptions.
- Redact authentication codes, access/refresh tokens, client secrets, and cookies in both structured data and text, including debug/error logs.
- Ignore malformed realtime messages without logging the raw payload; later valid updates must still work.
- Startup without plugin configuration, platform-only/minimal configuration, network failures, shutdown, and restart must not crash or create duplicate listeners.
- Cancel pending network work on shutdown and prevent delayed initialization from restarting clients after shutdown.

## GUI Installation and Bundles

Verified plugin bundles are generated from `dist-tags.latest`, with development dependencies omitted and install scripts disabled. A missing bundle or a requested beta version can use npm internally through the Homebridge GUI; the user does not need to run a terminal installation command.

For a scope migration, check verification/icon registration separately from the old-to-new name mapping. Validate both the stable bundle path and the beta installation path. The current scoped bundle release is `v2.0.0`; inspect the actual upstream code and assets rather than relying only on the legacy release link in its README.

## Evidence and Review Limits

Automatic checks run against the published npm package. Local fixes and commits do not change that result until a new package is published and checked. `/check` is an external issue comment, so submitting it requires the maintainer's instruction. Passing the automated checks is followed by manual review.

Static security scanners may flag legitimate sanitization or environment handling. Explain the actual behavior and data boundary rather than removing safe code to hide a warning. Existing Verified status does not waive ongoing privacy, maintenance, or stability requirements.

## Sources

- Homebridge Developer Docs: `https://developers.homebridge.io/`
- Official plugin template: `https://github.com/homebridge/homebridge-plugin-template`
- Custom UI utilities: `https://github.com/homebridge/plugin-ui-utils`
- Verified plugin requirements: `https://github.com/homebridge/plugins`
- Verification case studies: `https://github.com/homebridge/plugins/issues/1250`, `https://github.com/homebridge/plugins/issues/1249`, `https://github.com/homebridge/plugins/issues/1248`, `https://github.com/homebridge/plugins/issues/1246`, `https://github.com/homebridge/plugins/issues/1211`
- Bundle implementation reviewed: `https://github.com/homebridge/plugins/blob/06d6ce1fe6ef22f212235d59072833a88bdaffe7/src/plugin-tarballs/index.ts`
