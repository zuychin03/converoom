import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Circle, CircleHelp, Diamond, Pause, Square, X } from 'lucide-react';
import type { RecordData } from './api.js';
import { fmtDuration, seatCode, type Kind } from './model.js';

const ICONS: Record<Kind, ReactNode> = {
  live: <Circle size={8} fill="currentColor" strokeWidth={0} aria-hidden="true" className="dot" />,
  needs: <Diamond size={9} fill="currentColor" strokeWidth={0} aria-hidden="true" />,
  ok: <Check size={12} strokeWidth={2.75} aria-hidden="true" />,
  warn: <CircleHelp size={12} strokeWidth={2.4} aria-hidden="true" />,
  fail: <X size={12} strokeWidth={2.75} aria-hidden="true" />,
  idle: <Circle size={8} strokeWidth={2.6} aria-hidden="true" />,
  paused: <Pause size={10} strokeWidth={2.6} aria-hidden="true" />,
  closed: <Square size={9} strokeWidth={2.6} aria-hidden="true" />,
};

export function Status({ kind, children }: { kind: Kind; children: ReactNode }) {
  return (
    <span className={`status status-${kind}`}>
      {ICONS[kind]}
      <span>{children}</span>
    </span>
  );
}

export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function ErrorNotice({ children, dismiss }: { children: ReactNode; dismiss?: () => void }) {
  return (
    <div className="notice-error" role="alert">
      <AlertTriangle size={16} aria-hidden="true" />
      <span>{children}</span>
      {dismiss && (
        <button type="button" className="icon-button" aria-label="Dismiss error" onClick={dismiss}>
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function JsonDetails({ value, title = 'Raw record' }: { value: unknown; title?: string }) {
  return (
    <details className="raw">
      <summary>{title}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function Elapsed({ since }: { since: number }) {
  const now = useNow();
  return <span className="num">{fmtDuration(now - since)}</span>;
}

export function Countdown({ until, urgentBelow = 30000 }: { until: number; urgentBelow?: number }) {
  const now = useNow();
  const left = until - now;
  if (left <= 0) return <span className="num countdown expired">expired</span>;
  return (
    <span className={`num countdown${left < urgentBelow ? ' urgent' : ''}`}>
      {fmtDuration(left)}
    </span>
  );
}

export function When({ at }: { at: unknown }) {
  const date = new Date(typeof at === 'number' ? at : 0);
  return date.getTime() ? (
    <time className="num" dateTime={date.toISOString()} title={date.toLocaleString('en-AU')}>
      {date.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}
    </time>
  ) : null;
}

export function Gauge({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="gauge">
      <span className="gauge-label">{label}</span>
      <span
        className={`gauge-bar${pct >= 85 ? ' near' : ''}`}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(value, max)}
      >
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className="gauge-value num">
        {Math.round(value)}/{max}
      </span>
    </div>
  );
}

export function DurationBar({ elapsed, budget }: { elapsed: number; budget: number }) {
  const pct = budget > 0 ? Math.min(100, (elapsed / budget) * 100) : 0;
  return (
    <span
      className={`duration${pct >= 80 ? ' near' : ''}`}
      role="meter"
      aria-label="Turn time against its budget"
      aria-valuemin={0}
      aria-valuemax={Math.round(budget / 1000)}
      aria-valuenow={Math.round(Math.min(elapsed, budget) / 1000)}
    >
      <i style={{ width: `${pct}%` }} />
    </span>
  );
}

export function LiveDuration({ since, budget }: { since: number; budget: number }) {
  const now = useNow();
  return (
    <span className="timing">
      <DurationBar elapsed={now - since} budget={budget} />
      <span className="num">
        {fmtDuration(now - since)} of {fmtDuration(budget)}
      </span>
    </span>
  );
}

export function SeatCode({ id }: { id: string }) {
  return (
    <span className="code" aria-hidden="true">
      {seatCode(id).map((tone, i) => (
        <i key={i} className={`code-${tone}`} />
      ))}
    </span>
  );
}

export type Field = {
  key: string;
  label: string;
  hint?: string;
  type?: 'text' | 'textarea' | 'select' | 'json' | 'paths' | 'checkbox' | 'number';
  required?: boolean;
  value?: string;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
};
export type Action = {
  title: string;
  command: string;
  description?: string;
  confirm?: string;
  label?: string;
  fields?: Field[];
  args?: RecordData;
  danger?: boolean;
  onSuccess?: (result: unknown) => void;
};
export type Run = (name: string, args: RecordData) => Promise<unknown>;

export function ActionDialog({
  action,
  close,
  run,
}: {
  action: Action;
  close: () => void;
  run: Run;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const prefix = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries((action.fields ?? []).map((field) => [field.key, field.value ?? ''])),
  );
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
    };
  }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    try {
      const args: RecordData = { ...action.args };
      for (const field of action.fields ?? []) {
        const value = values[field.key] ?? '';
        if (field.required && !value.trim()) throw new Error(`Enter ${field.label.toLowerCase()}.`);
        if (field.type === 'json') {
          try {
            args[field.key] = JSON.parse(value);
          } catch {
            throw new Error(`${field.label} must contain valid JSON.`);
          }
        } else if (field.type === 'paths')
          args[field.key] = value
            .split('\n')
            .map((item) => item.trim())
            .filter(Boolean);
        else if (field.type === 'checkbox') args[field.key] = value === 'true';
        else if (field.type === 'number') args[field.key] = Number(value);
        else if (value || field.required) args[field.key] = value;
      }
      setBusy(true);
      const result = await run(action.command, args);
      action.onSuccess?.(result);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The action failed. Try again.');
    } finally {
      setBusy(false);
    }
  }
  const set = (key: string, value: string) => setValues({ ...values, [key]: value });
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={`${prefix}-title`}
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else close();
      }}
    >
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <div className="dialog-head">
          <h2 id={`${prefix}-title`}>{action.title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close dialog"
            disabled={busy}
            onClick={close}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        {action.description && <p className="dialog-copy">{action.description}</p>}
        {action.confirm && <p className="confirmation">{action.confirm}</p>}
        {action.fields?.map((field) => {
          const id = `${prefix}-field-${field.key}`;
          if (field.type === 'checkbox')
            return (
              <label className="check-field" key={field.key} htmlFor={id}>
                <input
                  id={id}
                  type="checkbox"
                  checked={values[field.key] === 'true'}
                  disabled={busy}
                  onChange={(event) => set(field.key, String(event.target.checked))}
                />
                <span>{field.label}</span>
              </label>
            );
          return (
            <label className="field" key={field.key} htmlFor={id}>
              <span className="field-label">
                {field.label}
                {field.required && <span aria-hidden="true"> *</span>}
              </span>
              {field.type === 'textarea' || field.type === 'json' || field.type === 'paths' ? (
                <textarea
                  id={id}
                  className={field.type === 'json' ? 'code-input' : ''}
                  value={values[field.key]}
                  rows={field.type === 'json' ? 8 : 3}
                  required={field.required}
                  disabled={busy}
                  onChange={(event) => set(field.key, event.target.value)}
                />
              ) : field.type === 'select' ? (
                <select
                  id={id}
                  value={values[field.key]}
                  required={field.required}
                  disabled={busy}
                  onChange={(event) => set(field.key, event.target.value)}
                >
                  <option value="">Choose…</option>
                  {field.options?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={id}
                  type={field.type === 'number' ? 'number' : 'text'}
                  value={values[field.key]}
                  required={field.required}
                  min={field.min}
                  max={field.max}
                  disabled={busy}
                  autoComplete="off"
                  onChange={(event) => set(field.key, event.target.value)}
                />
              )}
              {field.hint && <small>{field.hint}</small>}
            </label>
          );
        })}
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <div className="dialog-actions">
          <button type="button" className="button" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button
            className={`button ${action.danger ? 'danger' : 'primary'}`}
            disabled={busy}
            aria-busy={busy || undefined}
            type="submit"
          >
            {busy ? 'Working…' : (action.label ?? action.title)}
          </button>
        </div>
      </form>
    </dialog>
  );
}
