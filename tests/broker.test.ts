import { it, expect } from 'vitest';
import { provisionFixture } from '../packages/workspace/src/broker.js';
it('allocates actual distinct endpoints, denies other namespaces and revokes credentials at stop', async () => {
  const a = await provisionFixture('attempt-a', { provider: 'local-kv', seed: { value: 'a' } }),
    b = await provisionFixture('attempt-b', { provider: 'local-kv', seed: { value: 'b' } });
  try {
    expect(a.url).not.toBe(b.url);
    expect(
      (
        await fetch(a.url + '/namespace/attempt-a/value', {
          headers: { authorization: 'Bearer ' + a.token },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(a.url + '/namespace/attempt-b/value', {
          headers: { authorization: 'Bearer ' + a.token },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(b.url + '/namespace/attempt-b/value', {
          headers: { authorization: 'Bearer ' + a.token },
        })
      ).status,
    ).toBe(401);
    await a.close();
    await expect(
      fetch(a.url + '/namespace/attempt-a/value', {
        headers: { authorization: 'Bearer ' + a.token },
      }),
    ).rejects.toThrow();
    expect(a.requests).toBe(1);
  } finally {
    await a.close();
    await b.close();
  }
});
