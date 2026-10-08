import { useId, useRef, useState } from 'react';
import { AtSign, X } from 'lucide-react';
import { string, type RecordData } from './api.js';
import { ErrorNotice, SeatCode, type Run } from './components.js';
import { INTENTS, type Intent } from './model.js';

type Mention = { seatId: string; intent: Intent };
const TRIGGER = /(^|\s)@([^\s@]*)$/;

export function Composer({
  roomId,
  seats,
  run,
  disabled,
}: {
  roomId: string;
  seats: RecordData[];
  run: Run;
  disabled: boolean;
}) {
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const nameOf = (id: string) => string(seats.find((s) => s.id === id) ?? {}, 'name', 'Seat');
  const candidates = seats.filter(
    (s) => s.role !== 'observer' && !mentions.some((m) => m.seatId === s.id),
  );
  const matches =
    query === null
      ? []
      : candidates
          .filter((s) =>
            `${string(s, 'name')} ${string(s, 'product')}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .slice(0, 6);
  const open = !disabled && query !== null && matches.length > 0 && mentions.length < 5;

  function change(value: string, caret: number) {
    setText(value);
    const found = TRIGGER.exec(value.slice(0, caret));
    setQuery(found ? found[2] : null);
    setActive(0);
  }
  function pick(seat: RecordData) {
    const el = area.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(TRIGGER, '$1');
    setText(before + text.slice(caret));
    setMentions((list) => [...list, { seatId: string(seat, 'id'), intent: 'question' }]);
    setQuery(null);
    window.requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(before.length, before.length);
    });
  }
  function openPicker() {
    const el = area.current;
    if (!el) return;
    const caret = el.selectionStart ?? text.length;
    const spacer = caret > 0 && !/\s$/.test(text.slice(0, caret)) ? ' @' : '@';
    const next = text.slice(0, caret) + spacer + text.slice(caret);
    setText(next);
    setQuery('');
    setActive(0);
    window.requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret + spacer.length, caret + spacer.length);
    });
  }
  async function submit() {
    if (!text.trim() || disabled || sending) return;
    setSending(true);
    setError('');
    try {
      await run('room_post', { roomId, text, ...(mentions.length ? { mentions } : {}) });
      setText('');
      setMentions([]);
      setQuery(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Message failed. Try again.');
    } finally {
      setSending(false);
    }
  }
  function keyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((i) => (i + step + matches.length) % matches.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        pick(matches[active]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setQuery(null);
        return;
      }
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  }
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {mentions.length > 0 && (
        <ul className="mention-chips" aria-label="Directed recipients">
          {mentions.map((m) => (
            <li key={m.seatId} className="mention-chip">
              <SeatCode id={m.seatId} />
              <span className="mention-name">{nameOf(m.seatId)}</span>
              <select
                aria-label={`Intent for ${nameOf(m.seatId)}`}
                value={m.intent}
                onChange={(event) =>
                  setMentions((list) =>
                    list.map((x) =>
                      x.seatId === m.seatId ? { ...x, intent: event.target.value as Intent } : x,
                    ),
                  )
                }
              >
                {INTENTS.map((intent) => (
                  <option key={intent} value={intent}>
                    {intent}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="icon-button small"
                aria-label={`Remove ${nameOf(m.seatId)}`}
                onClick={() => setMentions((list) => list.filter((x) => x.seatId !== m.seatId))}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="composer-row">
        <label className="composer-field">
          <span className="field-label">Public message</span>
          <textarea
            ref={area}
            value={text}
            rows={2}
            placeholder={disabled ? 'This room is not open.' : 'Message the room. Type @ to direct a question.'}
            disabled={disabled || sending}
            aria-autocomplete="list"
            aria-controls={open ? listId : undefined}
            aria-activedescendant={open ? `${listId}-${active}` : undefined}
            onChange={(event) => change(event.target.value, event.target.selectionStart)}
            onKeyDown={keyDown}
            onBlur={() => window.setTimeout(() => setQuery(null), 120)}
          />
        </label>
        <div className="composer-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="Add a directed recipient"
            disabled={disabled || mentions.length >= 5}
            onClick={openPicker}
          >
            <AtSign size={16} aria-hidden="true" />
          </button>
          <button
            type="submit"
            className="button primary"
            aria-label="Post message"
            disabled={disabled || sending || !text.trim()}
            aria-busy={sending || undefined}
          >
            {sending ? 'Posting' : 'Post'}
          </button>
        </div>
      </div>
      {open && (
        <ul id={listId} className="mention-list" role="listbox" aria-label="Seats to direct">
          {matches.map((seat, i) => (
            <li
              key={string(seat, 'id')}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(seat);
              }}
            >
              <SeatCode id={string(seat, 'id')} />
              <span className="mention-name">{string(seat, 'name')}</span>
              <span className="muted">{string(seat, 'product')}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="sr-only" aria-live="polite">
        {open ? `${matches.length} seats match. Use the arrow keys and Enter to direct the message.` : ''}
      </p>
      {error && <ErrorNotice>{error}</ErrorNotice>}
    </form>
  );
}
