#!/usr/bin/env node
/**
 * claude-meta-mcp — entry point.
 *
 * Boots an Express server that exposes:
 *   - GET  /health        liveness probe
 *   - POST /mcp           MCP Streamable HTTP transport (Bearer-auth gated)
 *
 * v0.1 single-tenant: one shared Meta access token, one shared Bearer auth
 * token. Multi-tenant + OAuth 2.1 + DCR is planned for v0.2.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import express, { NextFunction, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { config } from "./config.js";
import { MetaClient } from "./meta-client.js";
import { MetaApiError } from "./meta-client.js";
import { registerTools } from "./tools.js";
import { registerWriteTools } from "./tools-write.js";
import { registerInstagramTools } from "./tools-instagram.js";
import { registerCatalogTools } from "./tools-catalogs.js";
import { registerAudienceTools } from "./tools-audiences.js";
import { registerAssetTools } from "./tools-assets.js";
import { AssetStore } from "./lib/assets.js";
import { registerUploadRoutes } from "./upload-page.js";
import { parseToolsets, restrictTools } from "./lib/toolsets.js";
import { createS3MediaStore } from "./lib/media-s3.js";

const VERSION = "0.6.0";

function log(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>
): void {
  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  if (order[level] < order[config.logLevel]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...extra,
  };
  // stderr keeps stdout clean for the (unused) stdio transport
  console.error(JSON.stringify(line));
}

const AUTH_DIGEST = createHash("sha256").update(config.authToken).digest();

/** Constant-time comparison against AUTH_TOKEN (hashing first equalises lengths). */
function secretMatches(candidate: string | undefined): boolean {
  if (!candidate) return false;
  return timingSafeEqual(createHash("sha256").update(candidate).digest(), AUTH_DIGEST);
}

function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const pathSecret = typeof req.params?.secret === "string" ? req.params.secret : undefined;
  if (!secretMatches(match?.[1]) && !(config.allowPathSecret && secretMatches(pathSecret))) {
    // Never log req.path: with ALLOW_PATH_SECRET it would contain the (attempted) secret.
    log("warn", "rejected unauthenticated MCP request", {
      ip: req.ip,
      route: pathSecret === undefined ? "/mcp" : "/mcp/:secret",
    });
    res.status(401).json({
      error: "unauthorized",
      message: "Missing or invalid Bearer token",
    });
    return;
  }
  next();
}

async function main(): Promise<void> {
  const meta = new MetaClient(config.meta.accessToken, config.meta.apiVersion);
  const assets = config.upload.dir ? new AssetStore(config.upload.dir, config.publicUrl) : undefined;
  const media = config.media.bucket
    ? createS3MediaStore(config.media.bucket, config.media.prefix, config.media.urlTtlSeconds)
    : undefined;
  if (assets) await assets.init();

  const allowedTools = parseToolsets(config.toolsets);
  if (config.allowPathSecret && !/^[A-Za-z0-9_-]{32,}$/.test(config.authToken)) {
    throw new Error("ALLOW_PATH_SECRET=true needs a URL-safe AUTH_TOKEN of 32+ chars (openssl rand -hex 32)");
  }

  // One McpServer per request: the SDK refuses to connect a server that is
  // still attached to another transport, so a shared instance fails with
  // "Already connected" whenever two requests overlap.
  function buildMcpServer(): McpServer {
    const mcp = new McpServer({
      name: "claude-meta-mcp",
      version: VERSION,
    });
    restrictTools(mcp, allowedTools);
    registerTools(mcp, meta);
    registerWriteTools(mcp, meta, assets);
    registerInstagramTools(mcp, meta, assets, {
      media,
      containerMaxWaitSeconds: config.igContainerMaxWaitSeconds,
    });
    registerCatalogTools(mcp, meta);
    registerAudienceTools(mcp, meta);
    registerAssetTools(mcp, assets);
    return mcp;
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "claude-meta-mcp",
      version: VERSION,
      meta_api_version: config.meta.apiVersion,
      asset_store: Boolean(assets),
    });
  });

  if (assets) {
    registerUploadRoutes(app, assets, {
      maxMb: config.upload.maxMb,
      lang: config.upload.pageLang,
      publicUrl: config.publicUrl,
    });
  }

  const mcpPaths = config.allowPathSecret ? ["/mcp", "/mcp/:secret"] : ["/mcp"];

  // Stateless server: no standalone SSE stream and no sessions to delete.
  app.get(mcpPaths, bearerAuth, (_req, res) => {
    res.status(405).set("Allow", "POST").json({ error: "method_not_allowed" });
  });
  app.delete(mcpPaths, bearerAuth, (_req, res) => {
    res.status(405).set("Allow", "POST").json({ error: "method_not_allowed" });
  });

  app.post(mcpPaths, bearerAuth, async (req, res) => {
    const mcp = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close().catch(() => {});
      mcp.close().catch(() => {});
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log("error", "MCP request failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        if (err instanceof MetaApiError) {
          res.status(502).json({
            error: "meta_api_error",
            meta: err.meta,
          });
        } else {
          res.status(500).json({
            error: "internal_error",
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
      }
    }
  });

  // Reject anything else with a hint
  app.use((req, res) => {
    res.status(404).json({
      error: "not_found",
      message: `${req.method} ${req.path} is not a valid endpoint. Use GET /health, POST /mcp${assets ? ", GET /upload or GET /assets/<id>" : ""}.`,
    });
  });

  app.listen(config.port, config.host, () => {
    log("info", "claude-meta-mcp listening", {
      host: config.host,
      port: config.port,
      version: VERSION,
      public_url: config.publicUrl,
      meta_api_version: config.meta.apiVersion,
      asset_store: assets ? config.upload.dir : null,
      toolsets: config.toolsets || "all",
      path_secret_enabled: config.allowPathSecret,
      media_bucket_configured: Boolean(media),
      ig_container_max_wait_s: config.igContainerMaxWaitSeconds,
    });
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
