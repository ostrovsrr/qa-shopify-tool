import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { migrateActorStorage, setInstanceDefault } from './api/actor';
import './index.css';

// Ask the instance whose it is BEFORE the first render.
//
// Each deployed instance belongs to one Solution Engineer, so it can supply the
// default display name and nobody has to type their own into every browser they
// open. Doing it here rather than in a component effect means the very first
// request already carries X-QA-User, and the badge never flashes "set name" before
// filling itself in.
//
// It is a label, not a login (see api/actor.ts) — so a failure here must never
// block the app. If the request fails, is slow, or the instance has no owner
// configured, the badge simply starts empty exactly as it did before.
async function loadInstanceDefault(): Promise<void> {
  try {
    const res = await fetch('/api/instance');
    if (!res.ok) return;
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && 'owner' in body) {
      setInstanceDefault((body as { owner: string | null }).owner);
    }
  } catch {
    // Deliberately silent: no default is a supported state, not an error.
  }
}

// Runs before anything reads a name: clears values stored back when clicking the
// badge silently persisted the instance default. One-time, per browser.
migrateActorStorage();

void loadInstanceDefault().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
