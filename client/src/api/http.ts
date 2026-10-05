import axios, { AxiosInstance } from 'axios';
import { attachActorHeader } from './actor';

/**
 * The one way this app talks to its server. validationApi, productApi and the
 * cleanup poller all build their client here, so every request carries the actor
 * header and every failure carries the server's own sentence.
 */
export function createApiClient(): AxiosInstance {
  const api = axios.create({ baseURL: '/api' });

  // Every request says who made it — display + audit only, never authorization.
  attachActorHeader(api);

  // Surface the server's { error } message instead of Axios's generic "Request
  // failed with status code N". Without this a busy store (409) reads as "Request
  // failed with status code 409" — the one message that tells the user nothing
  // about what to do — rather than "Store store1 is busy: …".
  api.interceptors.response.use(undefined, (err: unknown) => {
    if (axios.isAxiosError(err) && typeof err.response?.data?.error === 'string') {
      err.message = err.response.data.error;
    }
    return Promise.reject(err);
  });

  return api;
}

/** GET /shopify/stores answers 503 { stores: [], error, hint } when the instance
 *  has no stores configured. Reading only `stores` turned that into an empty
 *  picker, no message and a dead Import button — so throw the server's sentence
 *  (and its hint) for the panel to show. Shared by both flows. */
export function storesFromResponse<T>(status: number, data: unknown): T[] {
  const body = (data && typeof data === 'object' ? data : {}) as {
    stores?: T[];
    error?: string;
    hint?: string;
  };
  if (status >= 200 && status < 300 && Array.isArray(body.stores)) return body.stores;
  const reason =
    typeof body.error === 'string'
      ? body.hint
        ? `${body.error} — ${body.hint}`
        : body.error
      : `Could not load Shopify test stores (HTTP ${status}).`;
  throw new Error(reason);
}

/** /shopify/health answers non-2xx with a report body when a store is
 *  misconfigured, which is the point — but a 500 or a proxy's HTML 502 has no
 *  `ok` at all, and "unknown" must read as NOT ready, never as ready. */
export function healthFromResponse<T extends { ok: boolean; error?: string }>(
  status: number,
  data: unknown,
): T {
  if (data && typeof data === 'object' && typeof (data as { ok?: unknown }).ok === 'boolean') {
    return data as T;
  }
  const error =
    data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
      ? (data as { error: string }).error
      : `Store health check failed (HTTP ${status}).`;
  return { ok: false, error } as T;
}

/** A failure worth retrying: no response at all (network blip, server restarting)
 *  or a gateway/server-side status. A 4xx is the server's considered answer. */
export function isTransientError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const status = err.response?.status;
  return status === undefined || status >= 500 || status === 408 || status === 429;
}
