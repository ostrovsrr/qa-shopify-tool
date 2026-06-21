import { getShopifyConfig, ShopifyStoreConfig } from '../config/shopify';

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

interface GraphQLError {
  message: string;
  extensions?: { code?: string };
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
  extensions?: {
    cost?: {
      throttleStatus?: ThrottleStatus;
    };
  };
}

/** Auth/scope failures (401/403) — surfaced distinctly so the UI can tell the
 *  operator the token is wrong or missing scopes rather than a generic 500. */
export class ShopifyAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopifyAuthError';
  }
}

/** GraphQL `errors` array or transport failure that isn't auth-related. */
export class ShopifyApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopifyApiError';
  }
}

/** Config missing/invalid (env not set). */
export class ShopifyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopifyConfigError';
  }
}

export interface HealthReport {
  ok: boolean;
  storeId?: string;
  label?: string;
  shop?: string;
  apiVersion: string;
  grantedScopes: string[];
  missingScopes: string[];
  error?: string;
}

const REQUIRED_SCOPES = ['write_customers', 'read_customers'];

// Transient HTTP statuses worth retrying — Shopify's gateway returns 502/503/504
// under load and 429 when throttled; these are not real failures of our request.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
// 0.5s, 1s, 2s exponential backoff.
const backoffMs = (attempt: number): number => 500 * 2 ** (attempt - 1);

export class ShopifyClient {
  private config: ShopifyStoreConfig;
  private lastThrottle: ThrottleStatus | null = null;

  constructor(config: ShopifyStoreConfig) {
    this.config = config;
  }

  get throttleStatus(): ThrottleStatus | null {
    return this.lastThrottle;
  }

  get shop(): string {
    return this.config.shop;
  }

  private get endpoint(): string {
    return `https://${this.config.shop}/admin/api/${this.config.apiVersion}/graphql.json`;
  }

  /** Run a GraphQL operation. Throws ShopifyAuthError / ShopifyApiError.
   *  Transient gateway errors (429/5xx, network blips, non-JSON 5xx bodies) are
   *  retried with exponential backoff so a brief Shopify hiccup mid-poll doesn't
   *  fail the whole import. */
  async query<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const accessToken = await getAccessToken(this.config);
    let lastError: Error = new ShopifyApiError('Shopify request failed.');

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': accessToken,
          },
          body: JSON.stringify({ query, variables }),
        });
      } catch (err) {
        // Network/transport failure — transient, retry.
        lastError = new ShopifyApiError(
          `Could not reach Shopify at ${this.config.shop}: ${(err as Error).message}`,
        );
        if (attempt < MAX_ATTEMPTS) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      // Auth failures are never transient — surface immediately.
      if (res.status === 401 || res.status === 403) {
        throw new ShopifyAuthError(
          `Shopify rejected the Admin token (HTTP ${res.status}). Check the selected store credentials and that the app has write_customers + read_customers scopes.`,
        );
      }

      if (RETRYABLE_STATUS.has(res.status)) {
        lastError = new ShopifyApiError(
          `Shopify returned a transient HTTP ${res.status} from ${this.config.shop}.`,
        );
        if (attempt < MAX_ATTEMPTS) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      const text = await res.text();
      let body: GraphQLResponse<T>;
      try {
        body = JSON.parse(text) as GraphQLResponse<T>;
      } catch {
        lastError = new ShopifyApiError(
          `Shopify returned a non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`,
        );
        // A non-JSON 5xx is a gateway error page — retry; non-JSON 2xx/4xx is not.
        if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      if (body.extensions?.cost?.throttleStatus) {
        this.lastThrottle = body.extensions.cost.throttleStatus;
      }

      if (body.errors && body.errors.length > 0) {
        const access = body.errors.find(
          (e) => e.extensions?.code === 'ACCESS_DENIED',
        );
        if (access) {
          throw new ShopifyAuthError(
            `Access denied: ${access.message}. The app is likely missing a required scope (write_customers / read_customers).`,
          );
        }
        throw new ShopifyApiError(
          body.errors.map((e) => e.message).join('; '),
        );
      }

      if (!body.data) {
        throw new ShopifyApiError('Shopify response contained no data.');
      }
      return body.data;
    }

    throw lastError;
  }

  /** Smoke-test: confirm the token works and required scopes are granted. */
  async verifyConnection(): Promise<HealthReport> {
    const data = await this.query<{
      shop: { name: string; myshopifyDomain: string };
      currentAppInstallation: { accessScopes: { handle: string }[] };
    }>(
      `query health {
        shop { name myshopifyDomain }
        currentAppInstallation { accessScopes { handle } }
      }`,
    );

    const grantedScopes = data.currentAppInstallation.accessScopes.map(
      (s) => s.handle,
    );
    const missingScopes = REQUIRED_SCOPES.filter(
      (s) => !grantedScopes.includes(s),
    );

    return {
      ok: missingScopes.length === 0,
      storeId: this.config.id,
      label: this.config.label,
      shop: data.shop.myshopifyDomain,
      apiVersion: this.config.apiVersion,
      grantedScopes,
      missingScopes,
      error:
        missingScopes.length > 0
          ? `Missing required scope(s): ${missingScopes.join(', ')}`
          : undefined,
    };
  }
}

let cachedClient: ShopifyClient | null = null;
const cachedClients = new Map<string, ShopifyClient>();

interface TokenCacheEntry {
  accessToken: string;
  expiresAt: number;
}

const tokenCache = new Map<string, TokenCacheEntry>();

async function fetchClientCredentialsToken(config: ShopifyStoreConfig): Promise<TokenCacheEntry> {
  if (!config.clientId || !config.clientSecret) {
    throw new ShopifyConfigError(
      `${config.label} is missing clientId/clientSecret and has no adminToken fallback.`,
    );
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  let res: Response;
  try {
    res = await fetch(`https://${config.shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    });
  } catch (err) {
    throw new ShopifyApiError(
      `Could not request an Admin token for ${config.shop}: ${(err as Error).message}`,
    );
  }

  const text = await res.text();
  let parsed: { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ShopifyApiError(
      `Shopify returned a non-JSON token response (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }

  if (res.status >= 300 || !parsed.access_token) {
    throw new ShopifyAuthError(
      parsed.error_description ??
        parsed.error ??
        `Shopify token request failed for ${config.shop} (HTTP ${res.status}).`,
    );
  }

  const ttlSeconds = parsed.expires_in ?? 3600;
  return {
    accessToken: parsed.access_token,
    expiresAt: Date.now() + Math.max(ttlSeconds - 60, 60) * 1000,
  };
}

async function getAccessToken(config: ShopifyStoreConfig): Promise<string> {
  if (config.adminToken) return config.adminToken;

  const cached = tokenCache.get(config.id);
  if (cached && cached.expiresAt > Date.now()) return cached.accessToken;

  const fresh = await fetchClientCredentialsToken(config);
  tokenCache.set(config.id, fresh);
  return fresh.accessToken;
}

/** Returns a singleton client, or throws ShopifyConfigError if env is unset. */
export async function getShopifyClient(storeId?: string): Promise<ShopifyClient> {
  if (!storeId && cachedClient) return cachedClient;
  if (storeId && cachedClients.has(storeId)) return cachedClients.get(storeId)!;

  const result = getShopifyConfig(storeId);
  if (!result.ok) {
    throw new ShopifyConfigError(result.error);
  }

  const client = new ShopifyClient(result.config);
  if (storeId) {
    cachedClients.set(storeId, client);
  } else {
    cachedClient = client;
  }
  return client;
}

export function clearShopifyTokenCache(storeId?: string): void {
  if (storeId) {
    tokenCache.delete(storeId);
    return;
  }
  tokenCache.clear();
}

/** Kept for older imports in compiled scripts; prefer getShopifyClient(storeId). */
export function getDefaultShopifyClient(): ShopifyClient {
  if (cachedClient) return cachedClient;
  const result = getShopifyConfig();
  if (!result.ok) {
    throw new ShopifyConfigError(result.error);
  }
  cachedClient = new ShopifyClient(result.config);
  return cachedClient;
}
