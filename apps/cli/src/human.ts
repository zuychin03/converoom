import type { ToolArgs } from '../../../packages/shared/src/contracts.js';

export async function humanCommand(url: string, code: string, name: string, args: ToolArgs): Promise<unknown> {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' ||
    endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash)
    throw new Error('Human commands require the local loopback runtime');
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(url + path, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(35000),
    });
    const value = await response.json() as ToolArgs;
    if (!response.ok) throw new Error(String((value.error as ToolArgs)?.message ?? 'Human command failed'));
    return { response, value };
  };
  const paired = await request('/api/pair', {
    method: 'POST', headers: { origin: url, 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const cookie = paired.response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('The runtime did not establish a human session');
  const session = await request('/api/session', { headers: { cookie, origin: url } });
  const result = await request('/api/commands', {
    method: 'POST',
    headers: { cookie, origin: url, 'content-type': 'application/json', 'x-csrf-token': String(session.value.csrf) },
    body: JSON.stringify({ name, args: { ...args, clientKey: crypto.randomUUID() } }),
  });
  return result.value.result;
}
