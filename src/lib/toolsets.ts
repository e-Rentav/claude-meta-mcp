/**
 * Optional tool allowlist by group (TOOLSETS env var).
 *
 * Unset = every tool is registered (upstream behaviour). Set, e.g.
 * TOOLSETS=pages,instagram, and only tools in those groups are exposed to the
 * client; any tool not listed in a group is dropped (fail closed).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const TOOLSET_GROUPS: Record<string, readonly string[]> = {
  pages: ["list_pages", "list_page_posts", "get_page_insights", "create_page_post", "delete_page_post"],
  instagram: [
    "list_instagram_accounts", "list_instagram_posts", "get_instagram_insights", "get_instagram_post_insights",
    "create_instagram_post", "create_instagram_carousel", "delete_instagram_media",
    "list_instagram_comments", "reply_instagram_comment", "delete_instagram_comment", "hide_instagram_comment",
    "publish_instagram_container", "list_media",
  ],
  ads_read: [
    "list_ad_accounts", "get_ad_account", "list_campaigns", "get_campaign", "list_adsets", "list_ads",
    "get_insights", "list_creatives", "list_ad_images", "list_ad_videos", "get_video_processing_status",
    "preview_ad", "get_adset", "estimate_audience", "list_custom_audiences", "get_custom_audience",
    "list_pixels", "get_pixel_events",
  ],
  ads_write: [
    "upload_ad_image", "upload_ad_video", "create_ad_creative", "delete_ad_creative",
    "create_campaign", "update_campaign", "delete_campaign", "create_adset", "update_adset", "delete_adset",
    "create_ad", "update_ad", "delete_ad", "set_campaign_status", "set_adset_status", "set_ad_status",
  ],
  catalogs: [
    "list_businesses", "list_product_catalogs", "get_product_catalog", "list_product_feeds",
    "get_catalog_diagnostics", "list_catalog_products",
  ],
  assets: ["list_assets"],
};

/** Parse TOOLSETS. Returns undefined when unset (= allow everything). Throws on unknown group names. */
export function parseToolsets(raw: string | undefined): Set<string> | undefined {
  if (!raw || raw.trim() === "") return undefined;
  const allowed = new Set<string>();
  for (const group of raw.split(",").map((g) => g.trim().toLowerCase()).filter(Boolean)) {
    const names = TOOLSET_GROUPS[group];
    if (!names) {
      throw new Error(`TOOLSETS: unknown group "${group}". Valid: ${Object.keys(TOOLSET_GROUPS).join(", ")}`);
    }
    names.forEach((n) => allowed.add(n));
  }
  return allowed;
}

/**
 * Make `server` drop every tool whose name is not in `allowed` as it is registered.
 * Must be called before the register* functions run.
 */
export function restrictTools(server: McpServer, allowed: Set<string> | undefined): void {
  if (!allowed) return;
  const original = server.registerTool.bind(server) as (...args: unknown[]) => { remove(): void };
  (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (...args: unknown[]) => {
    const handle = original(...args);
    if (!allowed.has(String(args[0]))) handle.remove();
    return handle;
  };
}
