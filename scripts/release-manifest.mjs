import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex'),
  root = process.cwd(),
  meta = JSON.parse(readFileSync('package.json', 'utf8')),
  seen = new Set(),
  dependencies = [],
  notices = [];
function visit(name, from) {
  const req = createRequire(join(from, 'package.json'));
  let entry;
  try {
    entry = req.resolve(name + '/package.json');
  } catch {
    entry = req.resolve(name);
  }
  let dir = dirname(entry),
    pkg;
  while (true) {
    try {
      pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg.name === name) break;
    } catch {
      pkg = undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Missing metadata ' + name);
    dir = parent;
  }
  const id = name + '@' + pkg.version;
  if (seen.has(id)) return;
  seen.add(id);
  const files = readdirSync(dir).filter((n) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(n));
  if (!pkg.license) throw new Error('Licence metadata missing: ' + id);
  const texts = (files.length ? files : readdirSync(dir).filter((n) => /^readme/i.test(n))).map(
    (f) => ({ name: f, bytes: readFileSync(join(dir, f)) }),
  );
  dependencies.push({
    name,
    version: pkg.version,
    license: pkg.license,
    noticeStatus: files.length
      ? 'included licence text'
      : 'package supplies licence metadata and readme only; upstream licence text review open',
    notices: texts.map((f) => ({ name: f.name, sha256: digest(f.bytes) })),
  });
  notices.push(
    '## ' +
      id +
      '\n\nLicence: ' +
      pkg.license +
      '\n\n' +
      texts
        .map((f) => {
          const text = f.bytes
            .toString()
            .replaceAll('\r\n', '\n')
            .split('\n')
            .map((line) => line.trimEnd())
            .join('\n')
            .trim();
          return '```text\n' + text + '\n```';
        })
        .join('\n\n'),
  );
  for (const n of Object.keys(pkg.dependencies ?? {})) visit(n, dir);
}
for (const name of Object.keys(meta.dependencies)) visit(name, root);
const binary = 'native/bin/win32-x64/converoom-supervisor.exe';
const assets = [];
function asset(path) {
  const entries = readdirSync(path, { withFileTypes: true });
  for (const entry of entries) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) asset(file);
    else assets.push({ path: file.replaceAll('\\', '/'), sha256: digest(readFileSync(file)) });
  }
}
for (const dir of ['dist', 'plugins', 'packages/plugin-content', 'native/bin']) asset(dir);
writeFileSync(
  'RELEASE_MANIFEST.json',
  JSON.stringify(
    {
      schemaVersion: 1,
      assets,
      version: meta.version,
      date: '08/10/2026',
      status: 'Windows preview; mandatory V1 gates remain open',
      supportedPreview: { os: 'Windows 11', arch: 'x64', node: '24.21.0' },
      lockfile: 'npm-shrinkwrap.json',
      lockfileSha256: digest(readFileSync('npm-shrinkwrap.json')),
      native: [
        {
          path: binary,
          sha256: digest(readFileSync(binary)),
          source: 'native/supervisor/src/main.rs',
          sourceSha256: digest(readFileSync('native/supervisor/src/main.rs')),
          build: 'cargo build --release --locked; Windows x64',
          license: 'Apache-2.0',
          rustDependencies: ['windows-sys@0.61.2', 'windows-link@0.2.1'],
        },
      ],
      dependencies: dependencies.sort((a, b) => a.name.localeCompare(b.name)),
    },
    null,
    2,
  ) + '\n',
);
writeFileSync(
  'THIRD_PARTY_NOTICES.md',
  '# Third-party notices\n\nGenerated from the installed production dependency closure. Proprietary agent binaries are not included.\n\n' +
    notices.join('\n\n') +
    '\n',
);
console.log(
  'Recorded ' + dependencies.length + ' production dependency versions and licence notices.',
);
