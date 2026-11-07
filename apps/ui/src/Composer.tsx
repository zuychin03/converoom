import { useId, useRef, useState } from 'react';
import { AtSign, X } from 'lucide-react';
import { string, type RecordData } from './api.js';
import { ErrorNotice, SeatCode, type Run } from './components.js';
import { INTENTS, type Intent } from './model.js';

type Mention = { seatId: string; intent: Intent };
type Match = { key: string; label: string; detail: string; seat?: RecordData; ref?: string };
const TRIGGER = /(^|\s)@([^\s@]*)$/;

export function Composer({
  roomId,
  seats,
  run,
  disabled,
  reason,
  contexts = [],
}: {
  roomId: string;
  seats: RecordData[];
  run: Run;
  disabled: boolean;
  reason?: string;
  contexts?: RecordData[];
}) {
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [refs, setRefs] = useState<string[]>([]);
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
  // FR-63: @ also offers the room's imported contexts, attached by reference rather than typed into the text.
  const matches: Match[] =
    query === null
      ? []
      : [
          ...(mentions.length < 5 ? candidates : [])
            .filter((s) => `${string(s, 'name')} ${string(s, 'product')}`.toLowerCase().includes(query.toLowerCase()))
            .map((seat) => ({ key: string(seat, 'id'), label: string(seat, 'name'), detail: string(seat, 'product'), seat })),
          ...(refs.length < 10 ? contexts : [])
            .filter((c) => !refs.includes(string(c, 'ref')) && `${string(c, 'ref')} ${string(c, 'title')}`.toLowerCase().includes(query.toLowerCase()))
            .map((c) => ({ key: string(c, 'ref'), label: string(c, 'ref'), detail: string(c, 'title'), ref: string(c, 'ref') })),
        ].slice(0, 8);
  const open = !disabled && query !== null && matches.length > 0;

  function change(value: string, caret: number) {
    setText(value);
    const found = TRIGGER.exec(value.slice(0, caret));
    setQuery(found ? found[2] : null);
    setActive(0);
  }
  function pick(match: Match) {
    const el = area.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(TRIGGER, '$1');
    setText(before + text.slice(caret));
    if (match.seat) setMentions((list) => [...list, { seatId: match.key, intent: 'question' }]);
    else if (match.ref) setRefs((list) => [...list, match.ref!]);
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
      await run('room_post', { roomId, text, ...(mentions.length ? { mentions } : {}), ...(refs.length ? { contextRefs: refs } : {}) });
      setText('');
      setMentions([]);
      setRefs([]);
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
      {refs.length > 0 && (
        <ul className="mention-chips" aria-label="Attached context">
          {refs.map((ref) => (
            <li key={ref} className="mention-chip">
              <code className="mention-name">{ref}</code>
              <button type="button" className="icon-button small" aria-label={`Detach ${ref}`}
                onClick={() => setRefs((list) => list.filter((x) => x !== ref))}>
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
            placeholder={disabled ? reason ?? 'This room is not active.' : 'Message the room. Type @ to direct a question or attach context.'}
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
            disabled={disabled || (mentions.length >= 5 && refs.length >= 10)}
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
        <ul id={listId} className="mention-list" role="listbox" aria-label="Seats to direct and context to attach">
          {matches.map((match, i) => (
            <li
              key={match.key}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(match);
              }}
            >
              {match.seat ? <SeatCode id={match.key} /> : null}
              {match.seat ? <span className="mention-name">{match.label}</span> : <code className="mention-name">{match.label}</code>}
              <span className="muted">{match.detail}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="sr-only" aria-live="polite">
        {open ? `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}. Use the arrow keys and Enter to choose.` : ''}
      </p>
      {error && <ErrorNotice>{error}</ErrorNotice>}
    </form>
  );
}
