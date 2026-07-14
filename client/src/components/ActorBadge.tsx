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
  const [editing, setEditing] = useState(!getActor());

  const save = (): void => {
    setActor(name);
    setName(getActor());
    if (getActor()) setEditing(false);
  };

  if (editing) {
    return (
      <div className="actor-badge">
        <input
          className="actor-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          placeholder="your name"
          aria-label="Your name, shown on runs you upload"
          autoFocus
        />
        <button className="btn btn-small" onClick={save} disabled={!name.trim()}>
          Save
        </button>
      </div>
    );
  }

  return (
    <button
      className="actor-badge actor-badge-set"
      onClick={() => setEditing(true)}
      title="The name shown on runs you upload. Click to change."
    >
      <span className="actor-dot" />
      {name}
    </button>
  );
}
