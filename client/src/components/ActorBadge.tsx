import { useState } from 'react';
import { getActor, setActor } from '../api/actor';

// The tool is a shared workspace — everyone sees every run, and any colleague can
// clean up any store. So runs say who uploaded them and destructive actions are
// logged with a name. This is where that name is set: once, per browser.
//
// It is a LABEL, NOT A LOGIN. Nothing is gated on it and nothing ever should be
// (see api/actor.ts). Presenting it as a sign-in would be a lie about what it does.
export function ActorBadge(): JSX.Element {
  const [name, setName] = useState(getActor());
  // Starts CLOSED even when no name is set. Opening an input inside the nav bar on
  // first load reads as a login prompt, which is exactly the wrong idea — nothing is
  // gated on this — and it crowds the header for a value that is entirely optional.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const save = (): void => {
    setActor(draft);
    setName(getActor());
    setEditing(false);
  };

  const open = (): void => {
    setDraft(name);
    setEditing(true);
  };

  if (editing) {
    return (
      <span className="actor-badge">
        <input
          className="actor-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') setEditing(false);
          }}
          onBlur={save}
          placeholder="your name"
          aria-label="Your name, shown on runs you upload"
          autoFocus
        />
      </span>
    );
  }

  return (
    <button
      className={`actor-badge actor-badge-set ${name ? '' : 'actor-badge-unset'}`}
      onClick={open}
      title={
        name
          ? `Runs you upload are labelled "${name}". Click to change.`
          : 'Optional: add your name so colleagues can see who uploaded a run.'
      }
    >
      {name ? (
        <>
          <span className="actor-dot" />
          {name}
        </>
      ) : (
        'set name'
      )}
    </button>
  );
}
