interface Entry { path: string; kind: string; bytes: number; removable: boolean; detail: string }
interface Preview { digest: string; code: string; entries: Entry[]; removable: { count: number; bytes: number } }
interface Result { removed: Entry[]; failed: { name: string; path: string; message: string }[]; bytes: number }

function size(bytes: number): string {
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes, unit = -1;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return unit < 0 ? bytes + ' bytes' : value.toFixed(1) + ' ' + units[unit];
}
const workspaces = (n: number) => n + ' workspace' + (n === 1 ? '' : 's');
const line = (e: Entry) => `- ${e.path} · ${e.kind} · ${size(e.bytes)} · ${e.detail}`;

export function cleanupPreviewLines(preview: Preview): string[] {
  const removable = preview.entries.filter((e) => e.removable), kept = preview.entries.filter((e) => !e.removable);
  return [
    'Cleanup preview. Nothing was removed.',
    ...(removable.length ? [`Can be removed (${removable.length}, ${size(preview.removable.bytes)}):`, ...removable.map(line)] : []),
    ...(kept.length ? [`Kept (${kept.length}):`, ...kept.map(line)] : []),
    removable.length
      ? `To remove the ${workspaces(removable.length)} listed above, run: converoom cleanup --confirm ${preview.code}`
      : 'Nothing can be removed now.',
  ];
}

export function cleanupResultLines(result: Result): string[] {
  return [
    `Removed ${workspaces(result.removed.length)} (${size(result.bytes)}):`,
    ...result.removed.map((e) => '- ' + e.path),
    ...(result.failed.length ? [`Could not remove ${workspaces(result.failed.length)}; preview again to retry:`,
      ...result.failed.map((f) => `- ${f.path}: ${f.message}`)] : []),
  ];
}
