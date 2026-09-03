import { useState } from 'react';
import { getActor, getStoredActor, isUsingInstanceDefault, setActor } from '../api/actor';

// The tool is a shared workspace — everyone sees every run, and any colleague can
// clean up any store. So runs say who uploaded them and destructive actions are
// logged with a name. This is where that name is set: once, per browser.
//
// It is a LABEL, NOT A LOGIN. Nothing is gated on it and nothing ever should be
// (see api/actor.ts). Presenting it as a sign-in would be a lie about what it does.
export function ActorBadge(): JSX.Element {
  const [name, setName] = useState(getActor());
  // Whether that name came from this instance (SE7 -> "pratha") or the person typed
  // it. Only changes the wording of the tooltip -- both are equally just a label.
  const [isDefault, setIsDefault] = useState(isUsingInstanceDefault());
  // Starts CLOSED even when no name is set. Opening an input inside the nav bar on
  // first load reads as a login prompt, which is exactly the wrong idea — nothing is
  // gated on this — and it crowds the header for a value that is entirely optional.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const save = (): void => {
    setActor(draft);
    setName(getActor());
    setIsDefault(isUsingInstanceDefault());
    setEditing(false);
  };

  const open = (): void => {
    // Seed from the STORED name, not the displayed one. The displayed name may be
    // this instance's default, and because the input saves on blur, seeding from it
    // meant that merely clicking the badge to look at it wrote the default into
    // localStorage as a deliberate choice -- which then survived the instance being
    // renamed. Empty here means "riding the default", and blurring an empty box
    // correctly keeps it that way.
    setDraft(getStoredActor());
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
          placeholder={isDefault && name ? name : 'your name'}
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
          ? isDefault
            ? `Runs you upload are labelled "${name}", this instance's default. Click to change it for this browser.`
            : `Runs you upload are labelled "${name}". Click to change.`
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
