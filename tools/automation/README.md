# Smart Automation contract probe

Run from this repository root:

```sh
node tools/automation/verify-upstream.mjs
node tools/automation/verify-dirty-clone.mjs /tmp/hejhome-ui-alpha20-source
./node_modules/.bin/vitest run tests/automation-hap.test.ts
node tools/automation/run-host-integration.mjs
```

The probe checks out the **exact** official UI `v6.0.1-alpha.20` tag in `/tmp/hejhome-ui-alpha20-source` if it is absent, verifies commit `b85d97ff3777c6f72a451db9ba8c16bd530fab42`, reads the five rule modules from immutable Git blobs, transpiles them into a disposable temporary directory, and executes them against HAP shaped services. A dirty working tree cannot alter the rule code used by this probe. Pass an existing clone as the first argument to avoid downloading it; the probe leaves that clone untouched. A clone made by the probe is removed after the run. It does not start Homebridge or write to its configuration. It uses the repository's existing TypeScript dependency and does not install packages in this repository.

`PASS` confirms only the exercised **source behavior**. Every `LIMITATION` line is a reproduced or source inspected alpha behavior, not a safety pass. The companion Vitest test constructs actual Homebridge HAP accessories from this plugin and checks the produced characteristics, updates, write path, unknown reads, and fault state. It does not run UI alpha, HapClient discovery, a HomeKit controller, or physical Hejhome devices. See [the customer guide](../../docs/product-specs/smart-automation-guide.md) for setup and field acceptance cases.

The dirty-clone check creates and mutates only its own temporary clone, runs the official probe against it, then verifies that the supplied source checkout has the same Git status as before. Without an argument it downloads the exact tag into its own temporary directory. It never deletes or changes a checkout supplied by the caller.

`run-host-integration.mjs` installs `homebridge@2.4.1-beta.11` and `homebridge-config-ui-x@6.0.1-alpha.20` under a fresh OS temporary directory with `--global=false`, an explicit temporary `--prefix`, and package scripts disabled. To reuse an existing installation **under `/tmp`**, pass `--install-root /tmp/path`; the harness still creates a fresh temporary Homebridge storage and deletes only its own runtime directory. The UI alpha package is not edited. The test copies a synthetic fixture plugin and a thin adapter that uses the official alpha platform, controller, and actual HapClient. The controller's supported `createHapClient` seam supplies one `127.0.0.1` HAP instance because Bonjour does not advertise a loopback-only bridge. This leaves UI browser discovery untested.

Homebridge core treats `bind: ["127.0.0.1"]` as an advertisement restriction while its HAP socket still listens on `0.0.0.0`. A process-local preloader forces only the fixture HAP port onto `127.0.0.1` and asserts the address after binding; the fixture HTTP port also binds to `127.0.0.1`. The harness sends `SIGTERM`, uses a bounded `SIGKILL` fallback, verifies both ports closed, and removes its temporary storage. No Hejhome account, vendor network request, operational bridge, or physical device is used. C2 uses real one-minute timers, so the full run takes several minutes.

Integration `PASS` means the exact behavior was observed on synthetic HAP services. Host limitations are explicitly labeled; especially, UI alpha's `@homebridge/hap-client@5.4.0-beta.2` parses a successful HAP `204 No Content` as JSON and reports a false failure after the source device already changed. UI stable `5.29.0` uses hap-client `5.3.0` with `axios.put` and does not have this code path. The harness never changes HAP responses or patches upstream packages.
