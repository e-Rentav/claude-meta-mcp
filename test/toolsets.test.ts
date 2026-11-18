import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MediaStore, type MediaBackend } from "../src/lib/media-s3.js";
import { parseToolsets, TOOLSET_GROUPS } from "../src/lib/toolsets.js";

// Some tool modules read config at import time.
process.env.META_ACCESS_TOKEN ??= "test-token";
process.env.AUTH_TOKEN ??= "test-auth";

async function allRegisteredToolNames(): Promise<string[]> {
  const { MetaClient } = await import("../src/meta-client.js");
  const { registerTools } = await import("../src/tools.js");
  const { registerWriteTools } = await import("../src/tools-write.js");
  const { registerInstagramTools } = await import("../src/tools-instagram.js");
  const { registerCatalogTools } = await import("../src/tools-catalogs.js");
  const { registerAudienceTools } = await import("../src/tools-audiences.js");
  const { registerAssetTools } = await import("../src/tools-assets.js");
  const { AssetStore } = await import("../src/lib/assets.js");

  const names: string[] = [];
  const server = new McpServer({ name: "t", version: "0" });
  const original = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
  (server as unknown as { registerTool: (...a: unknown[]) => unknown }).registerTool = (...args: unknown[]) => {
    names.push(String(args[0]));
    return original(...args);
  };
  const meta = new MetaClient("test-token", "v26.0");
  const assets = new AssetStore("/tmp/unused-assets", "http://localhost");
  const backend: MediaBackend = { list: async () => ({ items: [] }), head: async () => null, presignGet: async () => "" };
  const media = new MediaStore(backend, "b", "inbox/", 3600);
  registerTools(server, meta);
  registerWriteTools(server, meta, assets);
  registerInstagramTools(server, meta, assets, { media, containerMaxWaitSeconds: 90 });
  registerCatalogTools(server, meta);
  registerAudienceTools(server, meta);
  registerAssetTools(server, assets);
  return names;
}

test("every registered tool belongs to a TOOLSETS group (otherwise TOOLSETS would silently drop it)", async () => {
  const grouped = new Set(Object.values(TOOLSET_GROUPS).flat());
  const orphans = (await allRegisteredToolNames()).filter((n) => !grouped.has(n));
  assert.deepEqual(orphans, []);
});

test("pages,instagram exposes the new media and publish tools, and no ads tool", () => {
  const allowed = parseToolsets("pages,instagram")!;
  for (const name of ["list_media", "publish_instagram_container", "create_instagram_post", "create_page_post"]) {
    assert.ok(allowed.has(name), name);
  }
  for (const name of ["upload_ad_image", "create_campaign", "get_product_catalog", "list_ad_accounts"]) {
    assert.ok(!allowed.has(name), name);
  }
});

test("unknown group names are rejected", () => {
  assert.throws(() => parseToolsets("pages,adz"), /unknown group "adz"/);
});
