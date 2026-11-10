import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { MIN_NODE, supportedNode } from '../apps/cli/src/support.js';

it('accepts Node 24.14 and every newer release line', () => {
  for (const version of ['24.14.0', '24.22.2', '25.9.0', '26.13.0', '27.0.0', '30.1.0']) expect(supportedNode(version), version).toBe(true);
  for (const version of ['24.13.1', '23.11.1', '22.23.4', '18.20.8']) expect(supportedNode(version), version).toBe(false);
});

it('publishes the Node floor the CLI enforces, with no upper bound', async () => {
  const engines = (path: string) => readFile(path, 'utf8').then((text) => JSON.parse(text));
  expect((await engines('package.json')).engines.node).toBe('>=' + MIN_NODE);
  expect((await engines('npm-shrinkwrap.json')).packages[''].engines.node).toBe('>=' + MIN_NODE);
  expect((await engines('RELEASE_MANIFEST.json')).supportedPreview).toMatchObject({ node: '>=' + MIN_NODE, testedNode: ['24.22.2', '26.13.0'] });
});

it.skipIf(!process.env.CONVEROOM_EXPECT_NODE)('runs on the Node release CI selected', () => {
  expect(process.versions.node).toBe(process.env.CONVEROOM_EXPECT_NODE);
});
