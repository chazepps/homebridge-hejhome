import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function releaseChannel(version, tag, lockVersion, configuredTag) {
  const number = '(?:0|[1-9][0-9]*)';
  const stable = new RegExp(`^${number}\\.${number}\\.${number}$`);
  const beta = new RegExp(`^${number}\\.${number}\\.${number}-beta\\.${number}$`);
  if (!stable.test(version) && !beta.test(version)) {
    throw new Error('Only stable or numbered beta versions may be published.');
  }
  const channel = beta.test(version) ? 'beta' : 'latest';
  if (tag !== `v${version}` || lockVersion !== version || configuredTag !== channel) {
    throw new Error('Release tag, lockfile, package version and publishConfig.tag must agree.');
  }
  return channel;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  if (lock.packages[''].version !== pkg.version) {
    throw new Error('Lockfile root package version differs.');
  }
  const channel = releaseChannel(pkg.version, process.argv[2], lock.version, pkg.publishConfig.tag);
  console.log(channel);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `channel=${channel}\n`);
  }
}
