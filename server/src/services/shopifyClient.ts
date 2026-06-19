import { getShopifyConfig, ShopifyConfig } from '../config/shopify';

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
  shop?: string;
  apiVersion: string;
  grantedScopes: string[];
  missingScopes: string[];
  error?: string;
}

const REQUIRED_SCOPES = ['write_customers', 'read_customers'];

export class ShopifyClient {
  private config: ShopifyConfig;
  private lastThrottle: ThrottleStatus | null = null;

  constructor(config: ShopifyConfig) {
    this.config = config;
  }

  get throttleStatus(): ThrottleStatus | null {
    return this.lastThrottle;
  }

  private get endpoint(): string {
    return `https://${this.config.shop}/admin/api/${this.config.apiVersion}/graphql.json`;
  }

  /** Run a GraphQL operation. Throws ShopifyAuthError / ShopifyApiError. */
  async query<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': this.config.adminToken,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      throw new ShopifyApiError(
        `Could not reach Shopify at ${this.config.shop}: ${(err as Error).message}`,
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new ShopifyAuthError(
        `Shopify rejected the Admin token (HTTP ${res.status}). Check SHOPIFY_ADMIN_TOKEN and that the custom app has write_customers + read_customers scopes.`,
      );
    }

    const text = await res.text();
    let body: GraphQLResponse<T>;
    try {
      body = JSON.parse(text) as GraphQLResponse<T>;
    } catch {
      throw new ShopifyApiError(
        `Shopify returned a non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`,
      );
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

/** Returns a singleton client, or throws ShopifyConfigError if env is unset. */
export function getShopifyClient(): ShopifyClient {
  if (cachedClient) return cachedClient;
  const result = getShopifyConfig();
  if (!result.ok) {
    throw new ShopifyConfigError(result.error);
  }
  cachedClient = new ShopifyClient(result.config);
  return cachedClient;
}
