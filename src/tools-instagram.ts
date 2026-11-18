/**
 * Instagram Graph API tools.
 *
 * The Instagram Graph API is a separate surface that hangs off Pages: every
 * Instagram Business / Creator account is connected to one Facebook Page,
 * and we discover IG accounts by walking /me/accounts and asking each Page
 * for its `instagram_business_account` field.
 *
 * Publishing is a 2-phase upload: create a media container, then publish it.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MetaClient } from "./meta-client.js";
import type { AssetStore } from "./lib/assets.js";
import { chatgptFileSchema, FILE_PARAMS_META, downloadChatGptFile, storeBlob } from "./lib/files.js";
import { buildAccountInsightsParams, buildMediaInsightsParams } from "./lib/ig-insights.js";
import { pollContainers, type PollDeps } from "./lib/ig-container.js";
import type { MediaStore } from "./lib/media-s3.js";

function asJson(value: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(value, null, 2) },
    ],
  };
}

interface PageWithIg {
  id: string;
  name: string;
  access_token?: string;
  instagram_business_account?: { id: string };
}

/** Status polling for Instagram media containers, using the Page token. */
function containerPoller(meta: MetaClient, pageToken: string): PollDeps {
  return {
    getStatus: (id) =>
      meta.get<{ status_code?: string; status?: string }>(`/${id}`, {
        access_token: pageToken,
        fields: "status,status_code",
      }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

export interface InstagramToolOptions {
  /** Private S3 media store (list_media, s3_key). Undefined = feature off. */
  media?: MediaStore;
  /** Max seconds a publish tool waits for video processing before handing back the container id. */
  containerMaxWaitSeconds?: number;
}

/** Exactly one media source per item. */
function pickSource(sources: Record<string, unknown>, what: string): string {
  const given = Object.entries(sources).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (given.length !== 1) {
    const names = Object.keys(sources).join(", ");
    throw new Error(`${what}: give exactly one of ${names} (got ${given.length === 0 ? "none" : given.map(([k]) => k).join(", ")})`);
  }
  return given[0][0];
}

export function registerInstagramTools(
  server: McpServer,
  meta: MetaClient,
  assets?: AssetStore,
  options: InstagramToolOptions = {}
): void {
  const media = options.media;
  const maxWaitMs = (options.containerMaxWaitSeconds ?? 90) * 1000;

  // -------------------------------------------------------------- Account discovery

  server.registerTool(
    "list_instagram_accounts",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description:
        "List Instagram Business / Creator accounts connected to Pages the System User manages. " +
        "Each entry returns the IG user ID (use this for posts, insights, comments).",
      inputSchema: {},
    },
    async () => {
      const pages = await meta.get<{ data: PageWithIg[] }>("/me/accounts", {
        fields: "id,name,instagram_business_account{id,username,name,profile_picture_url,followers_count,media_count,biography}",
        limit: 100,
      });
      const out = (pages.data ?? [])
        .filter((p) => p.instagram_business_account)
        .map((p) => ({
          page_id: p.id,
          page_name: p.name,
          instagram: p.instagram_business_account,
        }));
      return asJson({ data: out });
    }
  );

  // -------------------------------------------------------------- Read

  server.registerTool(
    "list_instagram_posts",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description: "List recent media items (posts, reels, stories) on an Instagram Business Account.",
      inputSchema: {
        ig_user_id: z.string().describe("Instagram Business Account ID (from list_instagram_accounts)"),
        page_id: z.string().describe("Connected Facebook Page ID (for Page Token lookup)"),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ ig_user_id, page_id, limit }) => {
      const pageToken = await meta.getPageAccessToken(page_id);
      const data = await meta.get(`/${ig_user_id}/media`, {
        access_token: pageToken,
        fields:
          "id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count",
        limit: limit ?? 25,
      });
      return asJson(data);
    }
  );

  server.registerTool(
    "get_instagram_insights",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description:
        "Fetch insights metrics for an Instagram Business account (default: reach, views as totals). " +
        "Optionally pass a since/until pair. Instagram `impressions` was removed in Graph API v22.",
      inputSchema: {
        ig_user_id: z.string(),
        page_id: z.string().describe("Connected Facebook Page ID"),
        metrics: z
          .array(z.string())
          .optional()
          .describe("Metric names. Default: reach, views"),
        period: z.enum(["day", "week", "days_28"]).optional(),
        metric_type: z
          .enum(["time_series", "total_value"])
          .optional()
          .describe(
            "total_value is required for views and most interaction metrics. " +
              "Default: total_value when metrics is omitted, otherwise not sent."
          ),
        since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      },
    },
    async ({ ig_user_id, page_id, metrics, period, metric_type, since, until }) => {
      const pageToken = await meta.getPageAccessToken(page_id);
      const data = await meta.get(`/${ig_user_id}/insights`, {
        access_token: pageToken,
        ...buildAccountInsightsParams({ metrics, period, metric_type, since, until }),
      });
      return asJson(data);
    }
  );

  server.registerTool(
    "get_instagram_post_insights",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description:
        "Fetch per-post insights for a single IG media item (default: reach, views). " +
        "Other valid metrics include saved, shares, likes, comments, total_interactions.",
      inputSchema: {
        media_id: z.string().describe("IG media item ID"),
        page_id: z.string().describe("Connected Page ID for token lookup"),
        metrics: z.array(z.string()).optional().describe("Default: reach, views"),
      },
    },
    async ({ media_id, page_id, metrics }) => {
      const pageToken = await meta.getPageAccessToken(page_id);
      const data = await meta.get(`/${media_id}/insights`, {
        access_token: pageToken,
        ...buildMediaInsightsParams(metrics),
      });
      return asJson(data);
    }
  );

  // -------------------------------------------------------------- Publishing

  if (media) {
    server.registerTool(
      "list_media",
      {
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        description:
          `List image/video files uploaded to the private media bucket (under ${media.prefix}). ` +
          "Pass a key as `s3_key` to create_instagram_post / create_instagram_carousel. " +
          "Files are uploaded by a person (S3 console or `aws s3 cp`), not through this tool.",
        inputSchema: {
          contains: z.string().max(200).optional().describe("Only keys containing this text (case-insensitive)"),
          limit: z.number().int().min(1).max(100).optional().describe("Max items (default 20), newest first"),
        },
      },
      async ({ contains, limit }) => {
        const { items, truncated } = await media.list(limit ?? 20, contains);
        return asJson({
          bucket: media.bucket,
          prefix: media.prefix,
          items,
          truncated,
          upload_hint: `aws s3 cp <arquivo> s3://${media.bucket}/${media.prefix}`,
        });
      }
    );
  }

  const s3KeyDescription = media
    ? `Key of a file in the private media bucket (from list_media), e.g. ${media.prefix}foto.jpg. ` +
      "The connector gives Meta a short-lived pre-signed URL."
    : "Not available: the media bucket is not configured on this server.";

  async function resolveS3(s3Key: string, expected: "image" | "video") {
    if (!media) throw new Error("s3_key is not available: MEDIA_BUCKET is not configured on this server");
    return media.resolveForInstagram(s3Key, expected);
  }

  server.registerTool(
    "create_instagram_post",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: FILE_PARAMS_META,
      description:
        "Publish a single image, video, or reel to an Instagram Business account. WRITE OPERATION. " +
        "Give exactly one media source: image_url / video_url (public URL Meta can download), " +
        "s3_key (file in the private media bucket, see list_media), or in ChatGPT an attached `file`. " +
        "For carousels (multi-image), use create_instagram_carousel. " +
        "Videos/reels are processed asynchronously: if processing takes longer than the server's wait, " +
        "the tool returns status 'processing' and a container_id — publish it later with publish_instagram_container.",
      inputSchema: {
        ig_user_id: z.string().describe("Instagram Business Account ID"),
        page_id: z.string().describe("Connected Facebook Page ID (for token lookup)"),
        media_type: z.enum(["IMAGE", "VIDEO", "REELS", "STORIES"]).describe("Type of media to publish"),
        image_url: z.string().url().optional().describe("Public URL of the image (for IMAGE)"),
        video_url: z.string().url().optional().describe("Public URL of the video (for VIDEO/REELS/STORIES)"),
        s3_key: z.string().max(1024).optional().describe(s3KeyDescription),
        caption: z.string().optional().describe("Caption text (max 2200 chars). Hashtags allowed."),
        thumb_offset: z.number().int().nonnegative().optional().describe("For VIDEO/REELS: ms offset for the cover frame"),
        location_id: z.string().optional().describe("Optional Facebook Place ID for location tag"),
        file: chatgptFileSchema.optional(),
      },
    },
    async ({ ig_user_id, page_id, media_type, image_url, video_url, s3_key, caption, thumb_offset, location_id, file }) => {
      const isImage = media_type === "IMAGE";
      const source = pickSource(
        isImage ? { image_url, s3_key, file } : { video_url, s3_key, file },
        `media_type ${media_type}`
      );
      if (isImage && video_url) throw new Error("media_type IMAGE takes image_url, not video_url");
      if (!isImage && image_url) throw new Error(`media_type ${media_type} takes video_url, not image_url`);

      const pageToken = await meta.getPageAccessToken(page_id);

      let mediaUrl: string;
      let sourceLabel: string | undefined;
      let storedAsset: { id: string; url: string } | undefined;
      if (source === "s3_key") {
        const resolved = await resolveS3(s3_key!, isImage ? "image" : "video");
        mediaUrl = resolved.url;
        sourceLabel = resolved.source;
      } else if (source === "file") {
        if (!assets) {
          throw new Error(
            "A ChatGPT file can only be published when the connector's asset store is configured (UPLOAD_DIR), " +
              "because Meta fetches Instagram media from a public URL. Use image_url / video_url or s3_key instead."
          );
        }
        const blob = await downloadChatGptFile(meta, file!, {
          mime: isImage ? "image/jpeg" : "video/mp4",
          filename: isImage ? "image.jpg" : "video.mp4",
        });
        const asset = await storeBlob(assets, blob, {
          file_name: file!.file_name,
          mime_type: file!.mime_type,
          source: "chatgpt-file",
        });
        storedAsset = { id: asset.id, url: asset.url };
        mediaUrl = asset.url;
      } else {
        mediaUrl = (isImage ? image_url : video_url)!;
      }

      const containerBody: Record<string, string | number> = {};
      if (isImage) {
        containerBody.image_url = mediaUrl;
      } else {
        containerBody.video_url = mediaUrl;
        containerBody.media_type = media_type;
        if (thumb_offset !== undefined) containerBody.thumb_offset = thumb_offset;
      }
      if (caption) containerBody.caption = caption;
      if (location_id) containerBody.location_id = location_id;

      // Phase 1: create container
      const started = Date.now();
      const container = await meta.post<{ id: string }>(`/${ig_user_id}/media`, containerBody, {
        access_token: pageToken,
      });
      const extra = {
        ...(sourceLabel ? { media_source: sourceLabel } : {}),
        ...(storedAsset ? { asset_url: storedAsset.url, asset_id: storedAsset.id } : {}),
      };

      // Phase 2 (videos/reels): wait for FINISHED, within the server's budget
      if (!isImage) {
        const poll = await pollContainers([container.id], started + maxWaitMs, containerPoller(meta, pageToken));
        if (!poll.ready) {
          return asJson({
            status: "processing",
            container_id: container.id,
            container_status: poll.statuses[container.id],
            next_step:
              `Instagram is still processing the video after ${Math.round((Date.now() - started) / 1000)}s. ` +
              `Call publish_instagram_container with container_id=${container.id} in a minute or two ` +
              "(the container stays valid for 24h). Do not call create_instagram_post again for this video.",
            ...extra,
          });
        }
      }

      // Phase 3: publish
      const published = await meta.post<{ id: string }>(
        `/${ig_user_id}/media_publish`,
        { creation_id: container.id },
        { access_token: pageToken }
      );

      return asJson({ status: "published", container_id: container.id, media_id: published.id, ...extra });
    }
  );

  server.registerTool(
    "create_instagram_carousel",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description:
        "Publish a multi-item carousel (2–10 images/videos) to an Instagram Business account. WRITE OPERATION. " +
        "Each item takes exactly one source: image_url / video_url or s3_key (see list_media). " +
        "If a video item is still processing when the server's wait ends, the tool returns status 'processing' " +
        "and the child_container_ids — finish with publish_instagram_container (pass the caption again).",
      inputSchema: {
        ig_user_id: z.string(),
        page_id: z.string(),
        items: z
          .array(
            z.object({
              type: z.enum(["IMAGE", "VIDEO"]).describe("Carousel child media type"),
              image_url: z.string().url().optional(),
              video_url: z.string().url().optional(),
              s3_key: z.string().max(1024).optional().describe(s3KeyDescription),
            })
          )
          .min(2)
          .max(10),
        caption: z.string().optional(),
      },
    },
    async ({ ig_user_id, page_id, items, caption }) => {
      // Validate every item before creating anything at Meta.
      const sources = items.map((item, i) => {
        const isImage = item.type === "IMAGE";
        if (isImage && item.video_url) throw new Error(`item ${i + 1}: IMAGE takes image_url, not video_url`);
        if (!isImage && item.image_url) throw new Error(`item ${i + 1}: VIDEO takes video_url, not image_url`);
        return pickSource(
          isImage ? { image_url: item.image_url, s3_key: item.s3_key } : { video_url: item.video_url, s3_key: item.s3_key },
          `item ${i + 1} (${item.type})`
        );
      });

      const pageToken = await meta.getPageAccessToken(page_id);
      const started = Date.now();

      // 1. Create one child container per item (videos process in parallel at Meta)
      const childIds: string[] = [];
      const videoChildIds: string[] = [];
      const mediaSources: string[] = [];
      for (const [i, item] of items.entries()) {
        const isImage = item.type === "IMAGE";
        let url: string;
        if (sources[i] === "s3_key") {
          const resolved = await resolveS3(item.s3_key!, isImage ? "image" : "video");
          url = resolved.url;
          mediaSources.push(resolved.source);
        } else {
          url = (isImage ? item.image_url : item.video_url)!;
          mediaSources.push(url);
        }
        const body: Record<string, string | number> = { is_carousel_item: "true" };
        if (isImage) {
          body.image_url = url;
        } else {
          body.video_url = url;
          body.media_type = "VIDEO";
        }
        const child = await meta.post<{ id: string }>(`/${ig_user_id}/media`, body, {
          access_token: pageToken,
        });
        childIds.push(child.id);
        if (!isImage) videoChildIds.push(child.id);
      }

      // 2. Wait for the video children, within the server's budget
      if (videoChildIds.length > 0) {
        const poll = await pollContainers(videoChildIds, started + maxWaitMs, containerPoller(meta, pageToken));
        if (!poll.ready) {
          return asJson({
            status: "processing",
            child_container_ids: childIds,
            container_statuses: poll.statuses,
            next_step:
              "Instagram is still processing at least one video. Call publish_instagram_container with " +
              `child_container_ids=${JSON.stringify(childIds)} and the same caption in a minute or two ` +
              "(containers stay valid for 24h). Do not call create_instagram_carousel again.",
          });
        }
      }

      // 3. Create the carousel container referencing the children, then publish
      const carouselBody: Record<string, string | number> = { media_type: "CAROUSEL", children: childIds.join(",") };
      if (caption) carouselBody.caption = caption;
      const carousel = await meta.post<{ id: string }>(`/${ig_user_id}/media`, carouselBody, {
        access_token: pageToken,
      });
      const published = await meta.post<{ id: string }>(
        `/${ig_user_id}/media_publish`,
        { creation_id: carousel.id },
        { access_token: pageToken }
      );

      return asJson({
        status: "published",
        child_container_ids: childIds,
        carousel_container_id: carousel.id,
        media_id: published.id,
        media_sources: mediaSources.map((s) => (s.startsWith("s3://") ? s : "url")),
      });
    }
  );

  server.registerTool(
    "publish_instagram_container",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description:
        "Finish a publish that returned status 'processing'. WRITE OPERATION. " +
        "Pass container_id (single video/reel) OR child_container_ids (+ caption) for a carousel. " +
        "Checks processing status; publishes when ready, otherwise returns 'processing' again.",
      inputSchema: {
        ig_user_id: z.string().describe("Instagram Business Account ID"),
        page_id: z.string().describe("Connected Facebook Page ID (for token lookup)"),
        container_id: z.string().optional().describe("Container id returned by create_instagram_post"),
        child_container_ids: z
          .array(z.string())
          .min(2)
          .max(10)
          .optional()
          .describe("Child container ids returned by create_instagram_carousel"),
        caption: z.string().optional().describe("Carousel caption (only with child_container_ids)"),
      },
    },
    async ({ ig_user_id, page_id, container_id, child_container_ids, caption }) => {
      pickSource({ container_id, child_container_ids }, "publish_instagram_container");
      if (container_id && caption) {
        throw new Error("caption only applies to child_container_ids; a single container keeps the caption it was created with");
      }
      const pageToken = await meta.getPageAccessToken(page_id);
      const poller = containerPoller(meta, pageToken);
      const started = Date.now();
      const shortWaitMs = Math.min(maxWaitMs, 30_000);

      if (container_id) {
        const poll = await pollContainers([container_id], started + shortWaitMs, poller);
        if (poll.statuses[container_id] === "PUBLISHED") {
          return asJson({ status: "already_published", container_id });
        }
        if (!poll.ready) {
          return asJson({ status: "processing", container_id, container_status: poll.statuses[container_id] });
        }
        const published = await meta.post<{ id: string }>(
          `/${ig_user_id}/media_publish`,
          { creation_id: container_id },
          { access_token: pageToken }
        );
        return asJson({ status: "published", container_id, media_id: published.id });
      }

      const children = child_container_ids!;
      const poll = await pollContainers(children, started + shortWaitMs, poller);
      if (!poll.ready) {
        return asJson({ status: "processing", child_container_ids: children, container_statuses: poll.statuses });
      }
      const carouselBody: Record<string, string | number> = { media_type: "CAROUSEL", children: children.join(",") };
      if (caption) carouselBody.caption = caption;
      const carousel = await meta.post<{ id: string }>(`/${ig_user_id}/media`, carouselBody, {
        access_token: pageToken,
      });
      const published = await meta.post<{ id: string }>(
        `/${ig_user_id}/media_publish`,
        { creation_id: carousel.id },
        { access_token: pageToken }
      );
      return asJson({ status: "published", child_container_ids: children, carousel_container_id: carousel.id, media_id: published.id });
    }
  );

  server.registerTool(
    "delete_instagram_media",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description: "Delete an Instagram media item (post/reel/story). DESTRUCTIVE.",
      inputSchema: {
        media_id: z.string(),
        page_id: z.string().describe("Connected Page ID for token lookup"),
      },
    },
    async ({ media_id, page_id }) => {
      const pageToken = await meta.getPageAccessToken(page_id);
      const data = await meta.delete(`/${media_id}`, { access_token: pageToken });
      return asJson(data);
    }
  );

  // -------------------------------------------------------------- Comments

  server.registerTool(
    "list_instagram_comments",
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description: "List comments on an IG media item.",
      inputSchema: {
        media_id: z.string(),
        page_id: z.string().describe("Connected Page ID for token lookup"),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ media_id, page_id, limit }) => {
      const pageToken = await meta.getPageAccessToken(page_id);
      const data = await meta.get(`/${media_id}/comments`, {
        access_token: pageToken,
        fields: "id,text,username,timestamp,like_count,replies",
        limit: limit ?? 25,
      });
      return asJson(data);
    }
  );

  server.registerTool(
    "reply_instagram_comment",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: "Reply to a comment on an IG post. WRITE OPERATION.",
      inputSchema: {
        comment_id: z.string().describe("ID of the comment to reply to"),
        page_id: z.string().describe("Connected Page ID for token lookup"),
        message: z.string().min(1).describe("Reply text"),
      },
    },
    async ({ comment_id, page_id, message }) => {
      const pageToken = await meta.getPageAccessToken(page_id);
      const data = await meta.post(
        `/${comment_id}/replies`,
        { message },
        { access_token: pageToken }
      );
      return asJson(data);
    }
  );

  server.registerTool(
    "delete_instagram_comment",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description: "Delete a comment from an IG post. DESTRUCTIVE.",
      inputSchema: {
        comment_id: z.string(),
        page_id: z.string().describe("Connected Page ID for token lookup"),
      },
    },
    async ({ comment_id, page_id }) => {
      const pageToken = await meta.getPageAccessToken(page_id);
      const data = await meta.delete(`/${comment_id}`, { access_token: pageToken });
      return asJson(data);
    }
  );

  server.registerTool(
    "hide_instagram_comment",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: "Hide or unhide a comment from public view (less destructive than delete). WRITE OPERATION.",
      inputSchema: {
        comment_id: z.string(),
        page_id: z.string().describe("Connected Page ID for token lookup"),
        hide: z.boolean().describe("true to hide, false to unhide"),
      },
    },
    async ({ comment_id, page_id, hide }) => {
      const pageToken = await meta.getPageAccessToken(page_id);
      const data = await meta.post(`/${comment_id}`, { hide }, { access_token: pageToken });
      return asJson(data);
    }
  );
}
