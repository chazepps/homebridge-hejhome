// Test-process-only isolation: HAP-NodeJS treats bind:['127.0.0.1'] as an
// advertisement restriction but listens on 0.0.0.0. Force only our HAP port.
import net from 'node:net';

const hapPort = Number(process.env.HEJ_AUTOMATION_HAP_PORT);
if (!Number.isInteger(hapPort) || hapPort < 1024 || hapPort > 65535) {
  throw new Error('HEJ_AUTOMATION_HAP_PORT must be a non-privileged TCP port.');
}

const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function loopbackListen(...args) {
  const first = args[0];
  const port = typeof first === 'object' && first !== null ? first.port : first;
  if (Number(port) === hapPort) {
    if (typeof first === 'object' && first !== null) {
      args[0] = { ...first, host: '127.0.0.1' };
    } else if (typeof args[1] === 'string') {
      args[1] = '127.0.0.1';
    } else {
      args.splice(1, 0, '127.0.0.1');
    }
    this.once('listening', () => {
      const address = this.address();
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
        this.close();
        throw new Error('Fixture HAP listener escaped loopback isolation.');
      }
      process.stdout.write(`FIXTURE_HAP_LOOPBACK port=${hapPort}\n`);
    });
  }
  return originalListen.apply(this, args);
};
