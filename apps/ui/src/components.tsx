import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X, AlertCircle, Plus, ArrowRight } from 'lucide-react';
import { type RecordData, string } from './api.js';

export function Status({ value }: { value: string }) {
  return (
    <span className={`status status-${value.toLowerCase().replace(/[^a-z]/g, '')}`}>
      {value.replaceAll('_', ' ')}
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
    <div className="error-notice" role="alert">
      <AlertCircle size={18} aria-hidden="true" />
      <span>{children}</span>
      {dismiss && (
        <button className="icon-button" aria-label="Dismiss error" onClick={dismiss}>
          <X size={18} />
        </button>
      )}
    </div>
  );
}
export function JsonDetails({
  value,
  title = 'Inspect record',
}: {
  value: unknown;
  title?: string;
}) {
  return (
    <details className="record-details">
      <summary>{title}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
export const describe = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '');
export function When({ at }: { at: unknown }) {
  const date = new Date(typeof at === 'number' || typeof at === 'string' ? at : 0);
  return date.getTime() ? (
    <time dateTime={date.toISOString()} title={date.toLocaleString('en-AU')}>
      {date.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}
    </time>
  ) : null;
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
  return (
    <dialog
      ref={ref}
      className="action-dialog"
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
        <div className="dialog-heading">
          <h2 id={`${prefix}-title`}>{action.title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close dialog"
            disabled={busy}
            onClick={close}
          >
            <X size={20} />
          </button>
        </div>
        {action.description && <p className="muted">{action.description}</p>}
        {action.confirm && <div className="confirmation">{action.confirm}</div>}
        {action.fields?.map((field) => (
          <label
            className={field.type === 'checkbox' ? 'check-field' : 'field'}
            key={field.key}
            htmlFor={`${prefix}-field-${field.key}`}
          >
            {field.type !== 'checkbox' && (
              <span>
                {field.label}
                {field.required && <span aria-hidden="true"> *</span>}
              </span>
            )}
            {field.type === 'textarea' || field.type === 'json' || field.type === 'paths' ? (
              <textarea
                id={`${prefix}-field-${field.key}`}
                className={field.type === 'json' ? 'code-input' : ''}
                value={values[field.key]}
                rows={field.type === 'json' ? 7 : 3}
                required={field.required}
                disabled={busy}
                onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
              />
            ) : field.type === 'select' ? (
              <select
                id={`${prefix}-field-${field.key}`}
                value={values[field.key]}
                required={field.required}
                disabled={busy}
                onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
              >
                <option value="">Choose…</option>
                {field.options?.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : field.type === 'checkbox' ? (
              <>
                <input
                  id={`${prefix}-field-${field.key}`}
                  type="checkbox"
                  checked={values[field.key] === 'true'}
                  required={field.required}
                  disabled={busy}
                  onChange={(event) =>
                    setValues({ ...values, [field.key]: String(event.target.checked) })
                  }
                />
                <span>{field.label}</span>
              </>
            ) : (
              <input
                id={`${prefix}-field-${field.key}`}
                type={field.type === 'number' ? 'number' : 'text'}
                value={values[field.key]}
                required={field.required}
                min={field.min}
                max={field.max}
                disabled={busy}
                onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
              />
            )}
            {field.hint && <small>{field.hint}</small>}
          </label>
        ))}
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button
            className={action.danger ? 'danger-button' : 'primary'}
            disabled={busy}
            type="submit"
          >
            {busy ? 'Working…' : (action.label ?? action.title)}
          </button>
        </div>
      </form>
    </dialog>
  );
}
export function AddButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick}>
      <Plus size={16} aria-hidden="true" />
      {children}
    </button>
  );
}
export function RecordRow({
  item,
  title,
  children,
}: {
  item: RecordData;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <article className="record-row">
      <div className="row-heading">
        <h3>{title ?? string(item, 'title', string(item, 'name', string(item, 'id')))}</h3>
        {string(item, 'status') && <Status value={string(item, 'status')} />}
      </div>
      {children}
      <JsonDetails value={item} />
    </article>
  );
}
export function LinkButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button className="text-button" onClick={onClick}>
      {children}
      <ArrowRight size={15} aria-hidden="true" />
    </button>
  );
}
