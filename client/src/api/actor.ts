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

/** An opaque slug — a first name or handle. Deliberately NOT an email: this lands in
 *  a shared history and in server logs, and there is no reason for it to carry a
 *  more personal identifier than the tool actually needs. */
export function normalizeActor(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 60);
}

export function getActor(): string {
  return localStorage.getItem(STORAGE_KEY) ?? '';
}

export function setActor(name: string): void {
  const slug = normalizeActor(name);
  if (slug) localStorage.setItem(STORAGE_KEY, slug);
  else localStorage.removeItem(STORAGE_KEY);
}

/** Attach the actor to every request the given client makes. */
export function attachActorHeader(api: AxiosInstance): void {
  api.interceptors.request.use((config) => {
    const actor = getActor();
    if (actor) config.headers.set('X-QA-User', actor);
    return config;
  });
}
