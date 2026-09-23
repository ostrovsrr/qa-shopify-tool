import type { EffectsPreview, PreviewableFlag, TemplateFlags } from '../api/validationApi';
import type { ValidationSummary } from '../types';

/**
 * The cleanup options, grouped by what they are FOR and showing what each would
 * do to this particular file.
 *
 * They used to be five bare checkboxes on one line in the header, each explaining
 * itself only in a title tooltip. The grouping matters because they are not five
 * of a kind: two make rejected rows importable, two decide what happens to
 * duplicates, and one is migration bookkeeping that changes nothing about what
 * imports.
 *
 * The per-option effect is the point. An operator ticking a box blind only learns
 * what it did after validating — which is exactly how the blank-row drop came as
 * a surprise. "+112 rows would import" answers "should I turn this on?" instead
 * of "what does this do?".
 */

type Setter = (value: boolean) => void;

interface Props {
  flags: TemplateFlags;
  set: Record<keyof TemplateFlags, Setter>;
  effects: EffectsPreview | null;
  effectsLoading: boolean;
  disabled: boolean;
}

interface OptionDef {
  key: keyof TemplateFlags;
  name: string;
  desc: string;
  /** Tagging changes no row's fate, so it gets no effect figure. */
  previewable: boolean;
}

const GROUPS: { title: string; hint: (e: ValidationSummary | null) => string; options: OptionDef[] }[] = [
  {
    title: 'Make rejected rows importable',
    hint: (e) => (e ? `${e.blocked} record${e.blocked === 1 ? '' : 's'} currently blocked` : ''),
    options: [
      {
        key: 'moveInvalidContactToNotes',
        name: 'Move invalid emails/phones to Note',
        desc: 'Clears a value Shopify would reject, keeps it in Note, tags the row. The rest of the record imports instead of the whole customer failing.',
        previewable: true,
      },
      {
        key: 'fillMissingContactName',
        name: 'Name contactless rows "Unknown"',
        desc: 'Shopify rejects a customer with no name, email and phone. Rows that are blank in every mapped column are removed rather than named.',
        previewable: true,
      },
    ],
  },
  {
    title: 'Handle duplicates',
    hint: (e) =>
      e && e.duplicateRecords > 0
        ? `${e.duplicateRecords} record${e.duplicateRecords === 1 ? '' : 's'} duplicated`
        : '',
    options: [
      {
        key: 'mergeMatchingDuplicates',
        name: 'Merge matching duplicates',
        desc: 'Runs first. Same email or phone AND a matching name becomes one customer; the most-filled row wins.',
        previewable: true,
      },
      {
        key: 'moveDuplicatesToNotes',
        name: 'Move duplicate emails/phones to Note',
        desc: 'For whatever is still duplicated, one row keeps the value and the rest stash it in Note.',
        previewable: true,
      },
    ],
  },
  {
    title: 'Migration bookkeeping',
    hint: () => 'no effect on what imports',
    options: [
      {
        key: 'heliosMigratedTag',
        name: 'Add HeliosMigrated Tag',
        desc: 'Tags every row so the migration is filterable in Shopify admin later.',
        previewable: false,
      },
    ],
  },
];

/** Ready + Fixed — the records Shopify would accept. */
const importable = (s: ValidationSummary) => s.ready + s.fixed;

export function OptionsPanel({ flags, set, effects, effectsLoading, disabled }: Props) {
  const current = effects?.current ?? null;

  /** What flipping this option would do, phrased from where the operator is now:
   *  turning it ON gains rows, turning it OFF loses them. */
  function effectFor(key: keyof TemplateFlags): { main: string; sub: string } | null {
    if (!effects) return null;
    const toggled = effects.toggled[key as PreviewableFlag];
    if (!toggled || !current) return null;

    const delta = importable(toggled) - importable(current);
    const isOn = !!flags[key];
    // Flipping an ON option means turning it off, so its contribution is the
    // negative of the delta.
    const contribution = isOn ? -delta : delta;

    const removedDelta = (isOn ? current.removed - toggled.removed : toggled.removed - current.removed);
    const subParts: string[] = [];
    if (removedDelta > 0) subParts.push(`${removedDelta} removed`);

    if (contribution === 0 && subParts.length === 0) {
      return { main: '—', sub: isOn ? 'no change if turned off' : 'nothing to change' };
    }
    return {
      main: `${contribution >= 0 ? '+' : ''}${contribution} row${Math.abs(contribution) === 1 ? '' : 's'}`,
      sub: isOn ? 'you would lose if off' : 'would import',
    };
  }

  return (
    <div className="options-panel">
      {GROUPS.map((group) => (
        <div key={group.title} className="options-group">
          <div className="options-group-head">
            <b>{group.title}</b>
            <span>{group.hint(current)}</span>
          </div>
          {group.options.map((opt) => {
            const on = !!flags[opt.key];
            const effect = opt.previewable ? effectFor(opt.key) : null;
            return (
              <label key={opt.key} className={`option-row${on ? ' is-on' : ''}`}>
                <input
                  type="checkbox"
                  className="option-switch"
                  checked={on}
                  onChange={(e) => set[opt.key](e.target.checked)}
                  disabled={disabled}
                />
                <span className="option-text">
                  <span className="option-name">{opt.name}</span>
                  <span className="option-desc">{opt.desc}</span>
                </span>
                {opt.previewable && (
                  <span className="option-effect">
                    {effectsLoading && !effect ? (
                      <span className="option-effect-idle">…</span>
                    ) : effect ? (
                      <>
                        {effect.main}
                        <small>{effect.sub}</small>
                      </>
                    ) : (
                      <span className="option-effect-idle">—</span>
                    )}
                  </span>
                )}
              </label>
            );
          })}
        </div>
      ))}

      {current && (
        <div className="options-tally">
          <div>
            <div className="options-tally-n">
              {importable(current).toLocaleString()} of {current.totalRows.toLocaleString()} would
              import
            </div>
            <div className="options-tally-l">
              With these options as they are now. Validate to see the full breakdown.
            </div>
          </div>
          <div className="options-tally-r">
            {current.blocked > 0 && <div>{current.blocked} still blocked</div>}
            {current.removed > 0 && <div>{current.removed} removed from the file</div>}
            {current.blocked === 0 && current.removed === 0 && <div>nothing blocked or removed</div>}
          </div>
        </div>
      )}
    </div>
  );
}
