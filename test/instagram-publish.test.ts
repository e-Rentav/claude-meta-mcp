import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MediaStore, type MediaBackend } from "../src/lib/media-s3.js";
import { registerInstagramTools } from "../src/tools-instagram.js";
import type { MetaClient } from "../src/meta-client.js";

const SIGNED = "https://signed.example/inbox/reel.mp4?X-Amz-Signature=abc";

/** Fake Graph API: records calls; containers report FINISHED once `state.ready` is true. */
function fakeMeta(initiallyReady: boolean) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const state = { ready: initiallyReady };
  let n = 0;
  const meta = {
    async getPageAccessToken() {
      return "page-token";
    },
    async post(path: string, body: Record<string, unknown>) {
      posts.push({ path, body });
      n += 1;
      return { id: path.endsWith("/media_publish") ? `media-${n}` : `container-${n}` };
    },
    async get(path: string) {
      if (path.startsWith("/container-")) return { status_code: state.ready ? "FINISHED" : "IN_PROGRESS" };
      return {};
    },
  };
  return { meta: meta as unknown as MetaClient, posts, state };
}

function media(): MediaStore {
  const objects: Record<string, string> = { "inbox/reel.mp4": "video/mp4", "inbox/foto.jpg": "image/jpeg" };
  const backend: MediaBackend = {
    list: async () => ({ items: [] }),
    head: async (key) => (objects[key] ? { contentType: objects[key] } : null),
    presignGet: async (key) => `https://signed.example/${key}?X-Amz-Signature=abc`,
  };
  return new MediaStore(backend, "bucket-x", "inbox/", 3600);
}

async function connect(meta: MetaClient, maxWaitSeconds: number) {
  const server = new McpServer({ name: "t", version: "0" });
  registerInstagramTools(server, meta, undefined, { media: media(), containerMaxWaitSeconds: maxWaitSeconds });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "c", version: "0" });
  await client.connect(clientT);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0].text;
  return { isError: Boolean(res.isError), text, json: res.isError ? undefined : JSON.parse(text) };
}

test("REELS from s3_key: Meta gets the pre-signed URL, the client never sees it", async () => {
  const { meta, posts } = fakeMeta(true);
  const client = await connect(meta, 90);
  const r = await call(client, "create_instagram_post", {
    ig_user_id: "ig1", page_id: "p1", media_type: "REELS", s3_key: "reel.mp4", caption: "oi",
  });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.status, "published");
  assert.equal(r.json.media_source, "s3://bucket-x/inbox/reel.mp4");
  assert.equal(posts[0].path, "/ig1/media");
  assert.equal(posts[0].body.video_url, SIGNED);
  assert.equal(posts[0].body.media_type, "REELS");
  assert.equal(posts[1].path, "/ig1/media_publish");
  assert.doesNotMatch(r.text, /Signature/);
});

test("slow video returns 'processing' with container_id; publish_instagram_container finishes it", async () => {
  const { meta, posts, state } = fakeMeta(false);
  const client = await connect(meta, 0.01);
  const first = await call(client, "create_instagram_post", {
    ig_user_id: "ig1", page_id: "p1", media_type: "REELS", s3_key: "inbox/reel.mp4",
  });
  assert.equal(first.json.status, "processing");
  assert.equal(first.json.container_id, "container-1");
  assert.match(first.json.next_step, /publish_instagram_container/);
  assert.equal(posts.filter((p) => p.path.endsWith("/media_publish")).length, 0);

  state.ready = true;
  const second = await call(client, "publish_instagram_container", {
    ig_user_id: "ig1", page_id: "p1", container_id: "container-1",
  });
  assert.equal(second.json.status, "published", second.text);
  assert.deepEqual(posts.at(-1), { path: "/ig1/media_publish", body: { creation_id: "container-1" } });
});

test("more than one source, or the wrong kind of source, is refused before calling Meta", async () => {
  const { meta, posts } = fakeMeta(true);
  const client = await connect(meta, 90);
  const both = await call(client, "create_instagram_post", {
    ig_user_id: "ig1", page_id: "p1", media_type: "IMAGE", s3_key: "foto.jpg", image_url: "https://x.example/a.jpg",
  });
  assert.equal(both.isError, true);
  assert.match(both.text, /exactly one of/);
  const wrongType = await call(client, "create_instagram_post", {
    ig_user_id: "ig1", page_id: "p1", media_type: "IMAGE", s3_key: "reel.mp4",
  });
  assert.equal(wrongType.isError, true);
  assert.match(wrongType.text, /expected image/);
  assert.equal(posts.length, 0);
});

test("carousel with a slow video returns child ids; publish with child_container_ids creates and publishes it", async () => {
  const { meta, posts, state } = fakeMeta(false);
  const client = await connect(meta, 0.01);
  const first = await call(client, "create_instagram_carousel", {
    ig_user_id: "ig1", page_id: "p1", caption: "c",
    items: [{ type: "IMAGE", s3_key: "foto.jpg" }, { type: "VIDEO", s3_key: "reel.mp4" }],
  });
  assert.equal(first.json.status, "processing", first.text);
  assert.deepEqual(first.json.child_container_ids, ["container-1", "container-2"]);
  assert.equal(posts.some((p) => p.body.media_type === "CAROUSEL"), false);

  state.ready = true;
  const second = await call(client, "publish_instagram_container", {
    ig_user_id: "ig1", page_id: "p1", child_container_ids: ["container-1", "container-2"], caption: "c",
  });
  assert.equal(second.json.status, "published", second.text);
  const carousel = posts.find((p) => p.body.media_type === "CAROUSEL");
  assert.deepEqual(carousel?.body, { media_type: "CAROUSEL", children: "container-1,container-2", caption: "c" });
  assert.equal(posts.at(-1)?.path, "/ig1/media_publish");
});
