import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// npm installs every entry of a dependency's shrinkwrap, dev ones included, so the packed copy keeps production entries only.
export function productionLockfile(text) {
  const lock = JSON.parse(text),
    packages = { '': { ...lock.packages[''] } };
  delete packages[''].devDependencies;
  for (const [path, entry] of Object.entries(lock.packages)) if (path && !entry.dev) packages[path] = entry;
  return JSON.stringify({ ...lock, packages }, null, 2) + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lockfile = 'npm-shrinkwrap.json',
    full = 'npm-shrinkwrap.full.json',
    step = process.argv[2];
  if (step === 'prepack') {
    if (existsSync(full))
      throw new Error(full + ' is left from an interrupted pack; run "node scripts/production-shrinkwrap.mjs postpack" to restore ' + lockfile + '.');
    const text = readFileSync(lockfile, 'utf8');
    renameSync(lockfile, full);
    writeFileSync(lockfile, productionLockfile(text));
  } else if (step === 'postpack') {
    if (existsSync(full)) renameSync(full, lockfile);
  } else throw new Error('Usage: node scripts/production-shrinkwrap.mjs prepack|postpack');
}
