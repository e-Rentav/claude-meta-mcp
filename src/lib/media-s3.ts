/**
 * Instagram media from a private S3 bucket.
 *
 * Files are uploaded by a person (S3 console or `aws s3 cp`) under MEDIA_PREFIX.
 * The publish tools take an `s3_key`; this module checks the object exists and
 * has the right content type, then returns a short-lived pre-signed GET URL
 * that Meta downloads. The URL is a bearer credential for that one object: it
 * is passed to Meta only, never returned to the client or logged.
 */

import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface MediaObject {
  key: string;
  size: number;
  last_modified?: string;
}

/** Storage operations used by MediaStore; the S3 implementation is below, tests pass a fake. */
export interface MediaBackend {
  list(prefix: string, maxKeys: number, continuationToken?: string): Promise<{ items: MediaObject[]; nextToken?: string }>;
  /** null when the object does not exist (or is not visible to this role). */
  head(key: string): Promise<{ contentType?: string; size?: number } | null>;
  presignGet(key: string, expiresInSeconds: number): Promise<string>;
}

export type ExpectedMedia = "image" | "video";

/**
 * Turn user input ("foto.jpg" or "inbox/foto.jpg") into a key under `prefix`.
 * Rejects anything that could point outside the prefix or at a "folder".
 */
export function normalizeMediaKey(input: string, prefix: string): string {
  let key = input.trim();
  if (key === "") throw new Error("s3_key is empty");
  if (key.length > 1024) throw new Error("s3_key is too long");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(key)) {
    throw new Error("s3_key must be an object key such as inbox/foto.jpg, not a URL");
  }
  if (/[\u0000-\u001f\u007f\\]/.test(key)) throw new Error("s3_key contains invalid characters");
  if (key.startsWith("/")) throw new Error("s3_key must not start with '/'");
  if (key.split("/").some((seg) => seg === "." || seg === "..")) {
    throw new Error("s3_key must not contain '.' or '..' path segments");
  }
  if (!key.startsWith(prefix)) key = prefix + key;
  if (key.endsWith("/")) throw new Error("s3_key points to a folder, not a file");
  return key;
}

export class MediaStore {
  constructor(
    private readonly backend: MediaBackend,
    readonly bucket: string,
    readonly prefix: string,
    private readonly urlTtlSeconds: number
  ) {}

  /** Newest-first is not guaranteed by S3; results are sorted by last_modified desc here. */
  async list(limit: number, contains?: string): Promise<{ items: MediaObject[]; truncated: boolean }> {
    const needle = contains?.toLowerCase();
    const items: MediaObject[] = [];
    let token: string | undefined;
    let pages = 0;
    do {
      const page = await this.backend.list(this.prefix, 1000, token);
      for (const item of page.items) {
        if (!needle || item.key.toLowerCase().includes(needle)) items.push(item);
      }
      token = page.nextToken;
      pages += 1;
    } while (token && pages < 10);
    items.sort((a, b) => (b.last_modified ?? "").localeCompare(a.last_modified ?? ""));
    return { items: items.slice(0, limit), truncated: items.length > limit || Boolean(token) };
  }

  /** Validate the object and return a pre-signed URL for Meta, plus a display label. */
  async resolveForInstagram(s3Key: string, expected: ExpectedMedia): Promise<{ key: string; url: string; source: string }> {
    const key = normalizeMediaKey(s3Key, this.prefix);
    const head = await this.backend.head(key);
    if (!head) {
      throw new Error(`s3_key not found: ${key}. Use list_media to see the files under ${this.prefix}`);
    }
    const contentType = (head.contentType ?? "").toLowerCase();
    if (!contentType.startsWith(`${expected}/`)) {
      throw new Error(
        `s3_key ${key} has content type "${contentType || "unknown"}", expected ${expected}/*. ` +
          "Upload it again with the right extension (S3 sets the type from it)."
      );
    }
    const url = await this.backend.presignGet(key, this.urlTtlSeconds);
    return { key, url, source: `s3://${this.bucket}/${key}` };
  }
}

export function createS3MediaStore(bucket: string, prefix: string, urlTtlSeconds: number): MediaStore {
  const client = new S3Client({});
  const backend: MediaBackend = {
    async list(listPrefix, maxKeys, continuationToken) {
      const res = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: listPrefix, MaxKeys: maxKeys, ContinuationToken: continuationToken })
      );
      return {
        items: (res.Contents ?? [])
          .filter((o) => o.Key && !o.Key.endsWith("/"))
          .map((o) => ({ key: o.Key!, size: o.Size ?? 0, last_modified: o.LastModified?.toISOString() })),
        nextToken: res.IsTruncated ? res.NextContinuationToken : undefined,
      };
    },
    async head(key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { contentType: res.ContentType, size: res.ContentLength };
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        // 404 = missing; 403 = missing and S3 hides it, or outside this role's access.
        if (status === 404 || status === 403) return null;
        throw err;
      }
    },
    presignGet(key, expiresInSeconds) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expiresInSeconds });
    },
  };
  return new MediaStore(backend, bucket, prefix, urlTtlSeconds);
}
