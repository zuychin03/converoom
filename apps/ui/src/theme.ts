import { useEffect, useState } from 'react';

export type ThemeChoice = 'dark' | 'light' | 'system';
const KEY = 'converoom.theme';

function stored(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === 'light' || value === 'system' ? value : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(choice: ThemeChoice) {
  document.documentElement.dataset.theme = choice;
  const dark =
    choice === 'dark' ||
    (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#0a0a0a' : '#f4f4f4');
}

export const initTheme = () => applyTheme(stored());

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(stored);
  useEffect(() => {
    applyTheme(choice);
    try {
      window.localStorage.setItem(KEY, choice);
    } catch {
      /* Private windows can refuse storage; the choice still applies for this visit. */
    }
    if (choice !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => applyTheme('system');
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [choice]);
  return { choice, setChoice };
}
