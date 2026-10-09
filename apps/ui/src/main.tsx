import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/mona-sans/wght.css';
import '@fontsource-variable/hubot-sans/wdth.css';
import '@fontsource-variable/martian-mono/wght.css';
import { App } from './App.js';
import { SharedApp } from './SharedApp.js';
import { initTheme } from './theme.js';
import './styles.css';
initTheme();
const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      {window.location.pathname.startsWith('/shared') ? <SharedApp /> : <App />}
    </StrictMode>,
  );
