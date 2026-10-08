import { it, expect } from 'vitest';
import { launch, run } from '../packages/adapters/src/process.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
it('supervises child trees and preserves literal argv', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'converoom-supervisor-'));
  try {
    const literal = 'literal $() "quoted" trailing\\';
    const r = await run(process.execPath, ['-e', 'console.log(process.argv[1])', literal], cwd);
    expect(r.output.trim()).toBe(literal);
    expect(r.exitCode).toBe(0);
    if (process.platform !== 'win32') return;
    const script =
      "const{spawn}=require('child_process');const fs=require('fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('descendant',String(c.pid));setInterval(()=>{},1000)";
    const parent = launch(process.execPath, ['-e', script], cwd);
    let pid = 0;
    for (let i = 0; i < 50; i++) {
      try {
        pid = Number(await readFile(join(cwd, 'descendant'), 'utf8'));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    expect(pid).toBeGreaterThan(0);
    parent.kill();
    await new Promise<void>((resolve) => parent.once('close', () => resolve()));
    let alive = true;
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(alive).toBe(false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
it('terminates owned descendants when the runtime parent dies', async () => {
  if (process.platform !== 'win32') return;
  const cwd = await mkdtemp(join(tmpdir(), 'converoom-parent-death-'));
  const helper = join(process.cwd(), 'native', 'bin', 'win32-x64', 'converoom-supervisor.exe');
  const descendant =
    "require('fs').writeFileSync('descendant',String(process.pid));setInterval(()=>{},1000)";
  const script =
    "require('child_process').spawn(process.argv[1],['--parent',String(process.pid),process.execPath,'-e',process.argv[2]],{stdio:'ignore',windowsHide:true});setInterval(()=>{},1000)";
  const parent = spawn(process.execPath, ['-e', script, helper, descendant], {
    cwd,
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    let pid = 0;
    for (let i = 0; i < 100; i++) {
      try {
        pid = Number(await readFile(join(cwd, 'descendant'), 'utf8'));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    expect(pid).toBeGreaterThan(0);
    parent.kill();
    await new Promise<void>((r) => parent.once('close', () => r()));
    let alive = true;
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(alive).toBe(false);
  } finally {
    parent.kill();
    await rm(cwd, { recursive: true, force: true });
  }
});
