import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { ConveroomError } from '../../shared/src/contracts.js';
import type { ToolArgs } from '../../shared/src/contracts.js';
export class RpcPeer {
  private next = 1;
  private pending = new Map<
    number,
    { resolve: (x: ToolArgs) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private buffer = '';
  readonly events = new EventEmitter();
  requestHandler?: (method: string, params: ToolArgs) => Promise<unknown>;
  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (part: string) => {
      this.buffer += part;
      if (this.buffer.length > 8388608) {
        this.fail(new ConveroomError('protocol_limit', 'Vendor protocol exceeded 8 MiB'));
        child.kill();
        return;
      }
      let i;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        if (line.trim()) this.receive(line);
      }
    });
    child.on('error', (e) => this.fail(e));
    child.on('close', () =>
      this.fail(new ConveroomError('vendor_disconnected', 'Vendor process disconnected')),
    );
  }
  private fail(e: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    this.events.emit('disconnected', e);
  }
  private receive(line: string) {
    try {
      const x = JSON.parse(line) as ToolArgs;
      if (typeof x.method === 'string') {
        if (x.id !== undefined) {
          void (
            this.requestHandler
              ? this.requestHandler(x.method, (x.params ?? {}) as ToolArgs)
              : Promise.reject(new Error('Unsupported request'))
          ).then(
            (result) => this.write({ id: x.id, result }),
            () =>
              this.write({
                id: x.id,
                error: { code: -32601, message: 'Request denied or unsupported' },
              }),
          );
        } else this.events.emit(x.method, x.params ?? {});
      } else if (typeof x.id === 'number') {
        const p = this.pending.get(x.id);
        if (p) {
          this.pending.delete(x.id);
          clearTimeout(p.timer);
          if (x.error)
            p.reject(
              new ConveroomError(
                'vendor_error',
                'Vendor request failed: ' + String((x.error as ToolArgs).message),
              ),
            );
          else p.resolve(x.result as ToolArgs);
        }
      }
    } catch {
      this.fail(new ConveroomError('protocol_error', 'Malformed vendor JSON-RPC response'));
    }
  }
  write(value: unknown) {
    if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  request(method: string, params: ToolArgs, timeout = 30000): Promise<ToolArgs> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ConveroomError('vendor_timeout', 'Vendor request timed out'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  notify(method: string, params?: ToolArgs) {
    this.write({ method, ...(params ? { params } : {}) });
  }
}
