# Smart Automation contract probe

Run from this repository root:

```sh
node tools/automation/verify-upstream.mjs
node tools/automation/verify-dirty-clone.mjs /tmp/hejhome-ui-alpha20-source
./node_modules/.bin/vitest run tests/automation-hap.test.ts
```

The probe checks out the **exact** official UI `v6.0.1-alpha.20` tag in `/tmp/hejhome-ui-alpha20-source` if it is absent, verifies commit `b85d97ff3777c6f72a451db9ba8c16bd530fab42`, reads the five rule modules from immutable Git blobs, transpiles them into a disposable temporary directory, and executes them against HAP shaped services. A dirty working tree cannot alter the rule code used by this probe. Pass an existing clone as the first argument to avoid downloading it; the probe leaves that clone untouched. A clone made by the probe is removed after the run. It does not start Homebridge or write to its configuration. It uses the repository's existing TypeScript dependency and does not install packages in this repository.

`PASS` confirms only the exercised **source behavior**. Every `LIMITATION` line is a reproduced or source inspected alpha behavior, not a safety pass. The companion Vitest test constructs actual Homebridge HAP accessories from this plugin and checks the produced characteristics, updates, write path, unknown reads, and fault state. It does not run UI alpha, HapClient discovery, a HomeKit controller, or physical Hejhome devices. See [the customer guide](../../docs/product-specs/smart-automation-guide.md) for setup and field acceptance cases.

The dirty-clone check creates and mutates only its own temporary clone, runs the official probe against it, then verifies that the supplied source checkout has the same Git status as before. Without an argument it downloads the exact tag into its own temporary directory. It never deletes or changes a checkout supplied by the caller.
