import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';

export interface IndexItem {
  id: string;
  group: 'Rooms' | 'Entries' | 'Actions';
  label: string;
  hint?: string;
  keywords?: string;
  run: () => void;
}

const GROUPS: IndexItem['group'][] = ['Actions', 'Rooms', 'Entries'];

function matches(items: IndexItem[], query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return items.filter((item) => item.group !== 'Entries');
  return items.filter((item) =>
    `${item.label} ${item.hint ?? ''} ${item.keywords ?? ''}`.toLowerCase().includes(q),
  );
}

export function CommandIndex({
  open,
  onClose,
  items,
}: {
  open: boolean;
  onClose: () => void;
  items: IndexItem[];
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const listId = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setQuery('');
      setActive(0);
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  const results = useMemo(() => matches(items, query).slice(0, 40), [items, query]);
  const ordered = GROUPS.flatMap((group) => results.filter((item) => item.group === group));
  const choose = (item: IndexItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };
  function keyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (ordered.length ? (i + step + ordered.length) % ordered.length : 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(ordered[active]);
    }
  }
  return (
    <dialog
      ref={ref}
      className="index-dialog"
      aria-label="Index"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="index-search">
        <Search size={16} aria-hidden="true" />
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={ordered[active] ? `${listId}-${ordered[active].id}` : undefined}
          aria-label="Search rooms, entry numbers and actions"
          placeholder="Jump to a room, an entry number or an action"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={keyDown}
        />
        <kbd>Esc</kbd>
      </div>
      <div id={listId} role="listbox" aria-label="Index results" className="index-results">
        {GROUPS.map((group) => {
          const items = ordered.filter((item) => item.group === group);
          if (!items.length) return null;
          return (
            <div role="group" aria-label={group} key={group} className="index-group">
              <p className="index-group-label" aria-hidden="true">
                {group}
              </p>
              {items.map((item) => {
                const index = ordered.indexOf(item);
                return (
                  <div
                    key={item.id}
                    id={`${listId}-${item.id}`}
                    role="option"
                    aria-selected={index === active}
                    className="index-option"
                    onMouseMove={() => setActive(index)}
                    onClick={() => choose(item)}
                  >
                    <span>{item.label}</span>
                    {item.hint && <span className="index-hint">{item.hint}</span>}
                  </div>
                );
              })}
            </div>
          );
        })}
        {!ordered.length && <p className="index-empty">Nothing matches “{query}”.</p>}
      </div>
    </dialog>
  );
}
