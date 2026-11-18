import { test } from "node:test";
import assert from "node:assert/strict";
import { MediaStore, normalizeMediaKey, type MediaBackend } from "../src/lib/media-s3.js";

const PREFIX = "inbox/";

test("normalizeMediaKey adds the prefix and keeps keys under it", () => {
  assert.equal(normalizeMediaKey("foto.jpg", PREFIX), "inbox/foto.jpg");
  assert.equal(normalizeMediaKey("inbox/foto.jpg", PREFIX), "inbox/foto.jpg");
  assert.equal(normalizeMediaKey("  campanha/nov/reel.mp4 ", PREFIX), "inbox/campanha/nov/reel.mp4");
});

test("normalizeMediaKey rejects traversal, URLs, folders and odd input", () => {
  for (const bad of [
    "",
    "../segredo.txt",
    "inbox/../outro/x.jpg",
    "inbox/./x.jpg",
    "/inbox/x.jpg",
    "https://exemplo.com/x.jpg",
    "s3://bucket/inbox/x.jpg",
    "inbox/pasta/",
    "inbox\\x.jpg",
    "inbox/x\u0000.jpg",
    "a".repeat(1025),
  ]) {
    assert.throws(() => normalizeMediaKey(bad, PREFIX), Error, `should reject ${JSON.stringify(bad.slice(0, 40))}`);
  }
});

function fakeBackend(objects: Record<string, { contentType?: string; last_modified?: string }>) {
  const presigned: Array<{ key: string; ttl: number }> = [];
  const backend: MediaBackend = {
    async list(prefix) {
      return {
        items: Object.entries(objects)
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, o]) => ({ key, size: 1, last_modified: o.last_modified })),
      };
    },
    async head(key) {
      const o = objects[key];
      return o ? { contentType: o.contentType, size: 1 } : null;
    },
    async presignGet(key, ttl) {
      presigned.push({ key, ttl });
      return `https://signed.example/${key}?X-Amz-Signature=secret`;
    },
  };
  return { backend, presigned };
}

test("resolveForInstagram presigns an existing image with the configured TTL", async () => {
  const { backend, presigned } = fakeBackend({ "inbox/foto.jpg": { contentType: "image/jpeg" } });
  const store = new MediaStore(backend, "bucket-x", PREFIX, 3600);
  const r = await store.resolveForInstagram("foto.jpg", "image");
  assert.equal(r.key, "inbox/foto.jpg");
  assert.equal(r.source, "s3://bucket-x/inbox/foto.jpg");
  assert.match(r.url, /^https:\/\/signed\.example\//);
  assert.deepEqual(presigned, [{ key: "inbox/foto.jpg", ttl: 3600 }]);
});

test("resolveForInstagram refers to list_media when the key is missing, without presigning", async () => {
  const { backend, presigned } = fakeBackend({});
  const store = new MediaStore(backend, "bucket-x", PREFIX, 3600);
  await assert.rejects(store.resolveForInstagram("nao-existe.jpg", "image"), /list_media/);
  assert.equal(presigned.length, 0);
});

test("resolveForInstagram refuses the wrong content type, and the error carries no signed URL", async () => {
  const { backend, presigned } = fakeBackend({ "inbox/video.mp4": { contentType: "video/mp4" } });
  const store = new MediaStore(backend, "bucket-x", PREFIX, 3600);
  await assert.rejects(store.resolveForInstagram("video.mp4", "image"), (err: Error) => {
    assert.match(err.message, /expected image\/\*/);
    assert.doesNotMatch(err.message, /Signature/);
    return true;
  });
  assert.equal(presigned.length, 0);
});

test("list filters, sorts newest first and reports truncation", async () => {
  const { backend } = fakeBackend({
    "inbox/a.jpg": { last_modified: "2026-11-01T00:00:00Z" },
    "inbox/b-reel.mp4": { last_modified: "2026-11-03T00:00:00Z" },
    "inbox/c-reel.mp4": { last_modified: "2026-11-02T00:00:00Z" },
    "outro/d.jpg": { last_modified: "2026-11-04T00:00:00Z" },
  });
  const store = new MediaStore(backend, "bucket-x", PREFIX, 3600);
  const all = await store.list(10);
  assert.deepEqual(all.items.map((i) => i.key), ["inbox/b-reel.mp4", "inbox/c-reel.mp4", "inbox/a.jpg"]);
  assert.equal(all.truncated, false);
  const reels = await store.list(1, "REEL");
  assert.deepEqual(reels.items.map((i) => i.key), ["inbox/b-reel.mp4"]);
  assert.equal(reels.truncated, true);
});
