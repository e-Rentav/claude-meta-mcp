/**
 * Environment configuration loader.
 *
 * Reads required variables from process.env, validates them, and exposes a
 * single typed `config` object for the rest of the codebase.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. See .env.example.`
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

function boundedInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return n;
}

function optionalInt(name: string): number | undefined {
  const value = process.env[name];
  if (!value || value.trim() === "") return undefined;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer (cents), got "${value}"`);
  }
  return n;
}

export const config = {
  port: parseInt(optional("PORT", "3210"), 10),
  /** Interface to bind. Use 127.0.0.1 when a local reverse proxy sits in front (recommended). */
  host: optional("HOST", "0.0.0.0"),
  logLevel: optional("LOG_LEVEL", "info") as
    | "debug"
    | "info"
    | "warn"
    | "error",
  meta: {
    accessToken: required("META_ACCESS_TOKEN"),
    apiVersion: optional("META_API_VERSION", "v26.0"),
  },
  /**
   * Bearer token a client must present in the Authorization header when
   * calling /mcp. In v0.1 (single-tenant), this is a single shared secret.
   * v0.2 will replace this with proper OAuth 2.1 + DCR.
   */
  authToken: required("AUTH_TOKEN"),
  /**
   * Also accept the secret as the last path segment (POST /mcp/<AUTH_TOKEN>),
   * for clients that cannot send an Authorization header. Off by default.
   */
  allowPathSecret: optional("ALLOW_PATH_SECRET", "false").toLowerCase() === "true",
  /** Comma-separated tool groups to expose (see src/lib/toolsets.ts). Empty = all tools. */
  toolsets: optional("TOOLSETS", ""),
  publicUrl: optional("PUBLIC_URL", "http://localhost:3210"),
  /**
   * Hard budget caps in account-currency cents. Undefined = no cap. Enforced
   * server-side on create_campaign / create_adset / update_campaign /
   * update_adset — a conversation cannot override them.
   */
  limits: {
    maxDailyBudgetCents: optionalInt("MAX_DAILY_BUDGET_CENTS"),
    maxLifetimeBudgetCents: optionalInt("MAX_LIFETIME_BUDGET_CENTS"),
  },
  /**
   * Asset store + /upload page. Enabled when UPLOAD_DIR is set. Files are
   * served at PUBLIC_URL/assets/<random-id>.<ext>; the reverse proxy must
   * authenticate /upload (see docs/DEPLOYMENT.md).
   */
  upload: {
    dir: process.env.UPLOAD_DIR && process.env.UPLOAD_DIR.trim() !== "" ? process.env.UPLOAD_DIR.trim() : undefined,
    maxMb: optionalInt("UPLOAD_MAX_MB") ?? 100,
    pageLang: (optional("UPLOAD_PAGE_LANG", "en") === "de" ? "de" : "en") as "en" | "de",
  },
  /**
   * Private S3 bucket for Instagram media. Enabled when MEDIA_BUCKET is set:
   * list_media lists MEDIA_PREFIX, and the publish tools accept `s3_key`,
   * turned into a pre-signed GET URL (MEDIA_URL_TTL_SECONDS) for Meta to fetch.
   */
  media: {
    bucket: process.env.MEDIA_BUCKET && process.env.MEDIA_BUCKET.trim() !== "" ? process.env.MEDIA_BUCKET.trim() : undefined,
    prefix: optional("MEDIA_PREFIX", "inbox/"),
    urlTtlSeconds: boundedInt("MEDIA_URL_TTL_SECONDS", 3600, 300, 43_200),
  },
  /**
   * How long the publish tools wait for an Instagram video container to finish
   * processing before returning its container_id (publish later with
   * publish_instagram_container). Keep well under the client and Lambda timeouts.
   */
  igContainerMaxWaitSeconds: boundedInt("IG_CONTAINER_MAX_WAIT_SECONDS", 90, 5, 240),
} as const;

export type Config = typeof config;
