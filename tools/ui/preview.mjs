import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';

// Keep the preview's host behavior identical to the Playwright fixture. This
// module and the fixture are development tools, never shipped in the plugin UI.
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtureBundle = await build({
  absWorkingDir: projectRoot,
  stdin: { contents: 'export { installUiHost } from "./tests/ui/host-fixture.ts";', resolveDir: projectRoot },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  plugins: [{
    name: 'preview-fixture-test-imports',
    setup(builder) {
      builder.onResolve({ filter: /^node:fs$|^@playwright\/test$/ }, ({ path }) => ({ path, namespace: 'test-only' }));
      builder.onLoad({ filter: /.*/, namespace: 'test-only' }, () => ({ contents: 'export const expect = undefined; export default undefined;' }));
    },
  }],
});
const { installUiHost } = await import(`data:text/javascript;base64,${Buffer.from(fixtureBundle.outputFiles[0].text).toString('base64')}`);
const devices = [
  { id: 'preview-living-light', name: '거실 조명', roomName: '거실', familyName: '우리 집', deviceType: 'LightRgbw5', modelName: 'Smart light',
    preference: {}, temperatureCelsius: null, powerSpecEligibility: { supported: true, reason: 'supported', powerField: 'power' } },
  { id: 'preview-living-plug', name: '데스크 플러그', roomName: '거실', familyName: '우리 집', deviceType: 'Plug', modelName: 'GKW-PG192',
    preference: { powerSpec: { activeWatts: 1.2, standbyWatts: 0.4 } },
    powerSpecEligibility: { supported: true, reason: 'supported', powerField: 'power' } },
  { id: 'preview-bedroom-relay', name: '침실 조명', roomName: '침실', familyName: '우리 집', deviceType: 'RelayController', modelName: 'GKW-RC031',
    preference: {}, powerSpecEligibility: { supported: true, reason: 'supported', powerField: 'power1' } },
  { id: 'preview-hall-motion', name: '복도 모션 센서', roomName: '복도', familyName: '우리 집', deviceType: 'SensorMo', modelName: 'GKZ-MO021',
    preference: {}, powerSpecEligibility: { supported: false, reason: 'unsupported-device' } },
  { id: 'preview-studio-curtain', name: '작업실 커튼', roomName: '작업실', familyName: '우리 집', deviceType: 'Curtain', modelName: 'Smart curtain',
    preference: {}, powerSpecEligibility: { supported: false, reason: 'unsupported-device' } },
  { id: 'preview-bedroom-plug', name: '침실 플러그', roomName: '침실', familyName: '우리 집', deviceType: 'Plug', modelName: 'GKMW-PG191',
    preference: {}, online: false, powerSpecEligibility: { supported: true, reason: 'supported', powerField: 'power' } },
  { id: 'preview-kitchen-switch', name: '주방 스위치', roomName: '주방', familyName: '우리 집', deviceType: 'Switch1', modelName: 'Wall switch',
    preference: {}, powerSpecEligibility: { supported: true, reason: 'supported', powerField: 'power1' } },
];
const port = Number(process.env.HEJ_UI_PREVIEW_PORT ?? 4173);
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    const language = url.searchParams.get('language') === 'en' ? 'en' : 'ko';
    const theme = url.searchParams.get('theme') === 'light' ? 'light' : 'dark';
    let hostScript = '';
    await installUiHost({ evaluate: async (callback, options) => {
      hostScript = `(${callback.toString()})(${JSON.stringify(options)});`;
    } }, {
      language,
      theme,
      devices,
      status: {
        configured: url.searchParams.get('login') !== 'true',
        sessionValid: url.searchParams.get('login') !== 'true',
        scopeOptions: { complete: true, families: [
          { familyId: 1, name: '우리 집', selected: true, rooms: [
            { roomId: 1, name: '거실', selected: true }, { roomId: 2, name: '침실', selected: true },
            { roomId: 3, name: '작업실', selected: true }, { roomId: 4, name: '주방', selected: true },
          ] },
        ] },
      },
    });
    // The fixture's observations remain static in tests. The local visual
    // preview instead represents a healthy, recurring diagnostic envelope;
    // offline sample devices retain their offline state and last-seen time.
    hostScript += `
      (() => {
        const host = window.homebridge;
        const state = window.__hejHost;
        const request = host.request.bind(host);
        host.request = (route, payload) => {
          if (route === '/diagnostics') {
            const now = new Date().toISOString();
            state.diagnostics.generatedAt = now;
            state.diagnostics.updatedAt = now;
            for (const device of state.diagnostics.devices) {
              if (device.online === true) device.lastSeenAt = now;
            }
          }
          return request(route, payload);
        };
      })();
    `;
    const fragment = await readFile(new URL('../../homebridge-ui/public/index.html', import.meta.url), 'utf8');
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(`<!doctype html><html lang="${language}"><head><meta charset="utf-8">`
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>Hejhome · Local UI fixture</title></head><body>'
      + '<div style="padding:8px 16px;background:#20252a;color:#c8d2d8;font:11px system-ui">'
      + 'LOCAL UI FIXTURE · Sample devices and simulated responses · '
      + '<a style="color:#9ce5cc" href="?theme=dark">Dark</a> / '
      + '<a style="color:#9ce5cc" href="?theme=light">Light</a> / '
      + '<a style="color:#9ce5cc" href="?language=en&amp;theme=dark">English</a> / '
      + '<a style="color:#9ce5cc" href="?login=true&amp;theme=dark">Sign in</a></div>'
      + `<script>${hostScript.replace(/<\/script/gi, '<\\/script')}</script>${fragment}</body></html>`);
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(error instanceof Error ? error.message : String(error));
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Local fixture preview: http://127.0.0.1:${port} (simulated data; no live device access)`);
});
