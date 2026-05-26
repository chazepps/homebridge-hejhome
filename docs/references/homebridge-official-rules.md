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

## Runtime Rules

- Restore cached accessories in `configureAccessory()`.
- Register or unregister accessories only after `didFinishLaunching`.
- Persist plugin files below Homebridge storage.
- Avoid postinstall scripts, tracking calls, and unhandled exceptions.

## Sources

- Homebridge Developer Docs: `https://developers.homebridge.io/`
- Official plugin template: `https://github.com/homebridge/homebridge-plugin-template`
- Custom UI utilities: `https://github.com/homebridge/plugin-ui-utils`
- Verified plugin requirements: `https://github.com/homebridge/plugins`
