import { AxiosInstance } from 'axios';

// ─────────────────────────────────────────────────────────────────────────────
// WHO AM I?
//
// The tool is a shared workspace: everybody sees every run, and any colleague can
// fire any of the destructive routes at any store. So a run says who uploaded it,
// and the destructive actions are logged with a name — because "where did my QA
// products go?" should have an answer.
//
// The name is picked once and kept in this browser. It is sent on every request as
// X-QA-User.
//
// ── THIS IS A LABEL, NOT A LOGIN ────────────────────────────────────────────
//
// Anyone can send any name. That is fine for what it is for: the failure mode it
// addresses is a MISTAKE ("who cleaned store2?"), not an attack, and everyone with
// access to this tool is already trusted with the data in it. It must never be used
// to decide what someone is allowed to see or do — that would be an authorization
// system built on a value the caller controls, which is worse than none at all
// because it would also LOOK like security.
//
// Real identity arrives with Cloudflare Access, from a verified JWT the browser
// cannot forge. At that point the server stops trusting this header for anything.
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'qa-tool-user';

// Bumped when stored names need discarding. See migrateActorStorage().
const SCHEMA_KEY = 'qa-tool-user-schema';
const SCHEMA_VERSION = '2';

// The name this INSTANCE belongs to, from GET /api/instance.
//
// Each instance is one Solution Engineer's (that is the isolation model), so it can
// supply a sensible default and nobody has to type their own name into every browser
// they use. It is only ever a FALLBACK: a name the person chose themselves is stored
// under STORAGE_KEY and always wins, so a colleague borrowing someone's URL can set
// their own and keep it.
//
// Deliberately not written to localStorage. Persisting it would make a default
// indistinguishable from a deliberate choice, and it would then survive even after
// the instance's owner changed -- which is exactly what went wrong once already.
let instanceDefault = '';

/** An opaque slug — a first name or handle. Deliberately NOT an email: this lands in
 *  a shared history and in server logs, and there is no reason for it to carry a
 *  more personal identifier than the tool actually needs.
 *
 *  Case is PRESERVED: the history reads "by Josh", not "by josh". Matching ignores
 *  case on the server instead (actorKey in services/actionLog.service). Must stay in
 *  step with that function -- if this strips a character the server keeps, a name
 *  typed here would not match the same name typed anywhere else. */
export function normalizeActor(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60);
}

export function setInstanceDefault(name: string | null | undefined): void {
  instanceDefault = normalizeActor(name ?? '');
}

/** Read a key without letting a locked-down browser take the whole app down.
 *  localStorage THROWS (not returns null) in some privacy modes. */
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** The name this browser explicitly chose, or '' when it is riding the instance
 *  default. Distinct from getActor(), and the difference matters: seeding the edit
 *  box from getActor() is what silently turned a default into a stored choice. */
export function getStoredActor(): string {
  return read(STORAGE_KEY) ?? '';
}

/**
 * Discard names stored before the instance served its own.
 *
 * ActorBadge used to seed its input from the DISPLAYED name and save on blur, so
 * merely clicking the badge to look at it wrote the instance default into
 * localStorage as though the person had typed it. Those values then outlived the
 * default they came from: an instance renamed "joshua" -> "Josh" kept showing
 * "joshua", and there was no way for the browser to tell that apart from a
 * deliberate choice.
 *
 * The leak itself is fixed (the input now seeds from getStoredActor()), but that
 * does nothing for values already written. So: one-time clear, once per browser.
 * Anyone who genuinely wants a name other than their instance's types it again,
 * once, and it sticks — this bump does not repeat.
 */
export function migrateActorStorage(): void {
  try {
    if (read(SCHEMA_KEY) === SCHEMA_VERSION) return;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.setItem(SCHEMA_KEY, SCHEMA_VERSION);
  } catch {
    // Storage unavailable. Nothing stored means nothing stale; the default applies.
  }
}

/** True when the current actor is this instance's default rather than a chosen name. */
export function isUsingInstanceDefault(): boolean {
  return !getStoredActor() && Boolean(instanceDefault);
}

export function getActor(): string {
  // `||` not `??`: an empty stored value means "no choice", not "chosen empty".
  return getStoredActor() || instanceDefault;
}

export function setActor(name: string): void {
  const slug = normalizeActor(name);
  try {
    if (slug) localStorage.setItem(STORAGE_KEY, slug);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable: the name applies to this page view and no further.
  }
}

/** Attach the actor to every request the given client makes. */
export function attachActorHeader(api: AxiosInstance): void {
  api.interceptors.request.use((config) => {
    const actor = getActor();
    if (actor) config.headers.set('X-QA-User', actor);
    return config;
  });
}
