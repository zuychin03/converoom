import { createHash } from 'node:crypto';
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
export function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function bytesDigest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function redact(text: string): string {
  return text
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,})/gi, '[redacted]')
    .replace(
      /((?:api[_-]?key|password|secret|token|authorization)\s*[=:]\s*)[^\s,;]+/gi,
      '$1[redacted]',
    )
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '[private reasoning omitted]');
}
