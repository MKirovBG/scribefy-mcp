#!/usr/bin/env node
/**
 * Scribefy MCP server.
 *
 * Exposes Scribefy as a tool any MCP-compatible client (Claude Desktop,
 * Cursor, Windsurf, custom agents) can call. The server is a thin
 * stdio-transport wrapper around the Scribefy REST API — the real work
 * (yt-dlp, caching, billing) happens on the API side.
 *
 * Configuration:
 *   SCRIBEFY_API_KEY   (required) — sk_live_… or sk_test_… key from
 *                                   the Scribefy dashboard.
 *   SCRIBEFY_API_BASE  (optional) — defaults to https://api.scribefy.app.
 *                                   Override for staging, dev, or self-hosted.
 *
 * Usage in a Claude Desktop / Cursor / Windsurf MCP config:
 *   {
 *     "mcpServers": {
 *       "scribefy": {
 *         "command": "npx",
 *         "args": ["-y", "scribefy-mcp"],
 *         "env": { "SCRIBEFY_API_KEY": "sk_live_…" }
 *       }
 *     }
 *   }
 */

import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Single source of truth for the server version: read it from package.json at
// runtime so MCP serverInfo always matches the published package version — no
// hard-coded literal to drift on each release. Resolved relative to THIS module
// (like scripts/sync-version.mjs), so it's correct in dev (tsx src/index.ts), in
// the built dist/index.js, and when installed from npm (dist/index.js →
// ../package.json at the package root, which npm always ships).
const { version: VERSION } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const DEFAULT_API_BASE = "https://api.scribefy.app";

const apiKey = process.env.SCRIBEFY_API_KEY ?? "";
const apiBase = (process.env.SCRIBEFY_API_BASE ?? DEFAULT_API_BASE).replace(/\/$/, "");

const DASHBOARD_URL = "https://scribefy.app/dashboard";
const PRICING_URL = "https://scribefy.app/pricing";

// Every Scribefy endpoint is auth-gated, so a usable key is required for ALL
// tools. When it's missing or malformed we don't crash the MCP host — the tool
// handlers return clear setup guidance (see keyGuard()), so the user gets
// actionable instructions in their AI client instead of a cryptic failure.
const keyMissing = apiKey.length === 0;
const keyWrongShape =
  apiKey.length > 0 && !apiKey.startsWith("sk_live_") && !apiKey.startsWith("sk_test_");

const NO_KEY_MESSAGE = [
  "No Scribefy API key found — Scribefy's tools need a key to work.",
  "",
  `• Already have an API + MCP plan? Copy your key from ${DASHBOARD_URL} and add it to this`,
  '  server\'s config:  "env": { "SCRIBEFY_API_KEY": "sk_live_…" }  — then restart your AI client.',
  `• New here? Create an account and subscribe to the API + MCP plan at ${PRICING_URL},`,
  "  then grab your key from the dashboard.",
].join("\n");

const BAD_KEY_SHAPE_MESSAGE = [
  'Your SCRIBEFY_API_KEY doesn\'t look like a Scribefy key (it should start with "sk_live_").',
  `Copy the exact key from ${DASHBOARD_URL} and update your MCP config, then restart your AI client.`,
].join("\n");

// Startup diagnostics — stderr only (stdout is owned by the JSON-RPC
// transport). MCP host UIs (Claude Desktop, Cursor) surface these in logs.
if (keyMissing) {
  console.error(
    `scribefy-mcp: SCRIBEFY_API_KEY not set — tools will return setup instructions. Get a key at ${DASHBOARD_URL}`,
  );
}
if (keyWrongShape) {
  console.error(
    "scribefy-mcp: SCRIBEFY_API_KEY doesn't look like a Scribefy key (expected sk_live_… or sk_test_…).",
  );
}

interface Segment {
  start: number;
  text: string;
}

interface ExtractResponse {
  videoId: string;
  title: string;
  channel: string;
  uploadDate: string;
  durationSec: number;
  description: string;
  language: string;
  auto: boolean;
  segments: Segment[];
  cached: boolean;
}

/** Format seconds as M:SS or H:MM:SS. */
function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`;
}

/** Render the extract result as Markdown so the LLM can quote / search easily. */
function renderTranscript(result: ExtractResponse): string {
  const lines: string[] = [];
  lines.push(`# ${result.title}`);
  lines.push("");
  lines.push(`**Channel:** ${result.channel}`);
  lines.push(`**Duration:** ${fmtTime(result.durationSec)}`);
  lines.push(`**Language:** ${result.language}${result.auto ? " (auto-generated)" : ""}`);
  lines.push(`**Video ID:** ${result.videoId}`);
  if (result.cached) lines.push(`**Cache hit:** yes (no credits debited)`);
  lines.push("");
  lines.push("## Transcript");
  lines.push("");
  for (const segment of result.segments) {
    lines.push(`**[${fmtTime(segment.start)}]** ${segment.text}`);
    lines.push("");
  }
  return lines.join("\n");
}

interface ApiErrorBody {
  error?: string;
  detail?: unknown;
  balance?: number;
  required?: number;
  buyUrl?: string;
  retryable?: boolean;
}

/** Translate Scribefy API errors into something an LLM can act on. */
function explainApiError(status: number, body: ApiErrorBody): string {
  switch (body.error) {
    case "UNAUTHENTICATED":
      return [
        "Scribefy couldn't authenticate your API key.",
        "",
        "It may be invalid, revoked, or your API + MCP plan may have lapsed.",
        `Verify your key and plan at ${DASHBOARD_URL}`,
        `(manage or renew your plan at ${PRICING_URL}).`,
      ].join("\n");
    case "INSUFFICIENT_CREDITS":
      return `Not enough credits to extract this video. You have ${body.balance ?? "?"} and need ${body.required ?? "?"}. Top up at https://scribefy.app/pricing.`;
    case "INVALID_URL":
      return "That doesn't look like a YouTube URL. Make sure it's a youtube.com / youtu.be / shorts link with a valid video ID.";
    case "NO_CAPTIONS":
      return "This video has no captions available — Scribefy can only extract videos with captions (auto-generated or human-authored).";
    case "LANG_UNAVAILABLE":
      return "The requested language isn't available for this video. Try a different language code or omit it to use the default.";
    case "VIDEO_UNAVAILABLE":
      return "The video is private, removed, age-restricted, or otherwise unavailable to Scribefy.";
    case "BOT_CHECK":
      return "YouTube briefly challenged Scribefy. Wait a minute and try again.";
    case "FETCH_FAILED":
      return "Couldn't reach YouTube right now. Try again in a moment.";
    case "INVALID_BODY":
      return "Request body was malformed (likely a bug in the MCP wrapper). Please report this.";
    default:
      return `Scribefy returned HTTP ${status}${body.error ? ` ${body.error}` : ""}.`;
  }
}

const server = new McpServer(
  {
    name: "scribefy-mcp",
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: [
      "Scribefy is a YouTube research toolkit for AI workflows. Tools:",
      "",
      "• extract_transcript — full transcript with timestamps (costs credits, 1–8 by length; cached free)",
      "• search_videos — free-text search across YouTube (free)",
      "• get_video_metadata — title, channel, duration, view count, caption tracks (free)",
      "• get_related_videos — YouTube's \"Up next\" feed for a video (free)",
      "",
      "Typical workflow: search to find videos → get_video_metadata to filter → extract_transcript on the chosen ones.",
      "",
      "Channel-listing and comments tools are coming in a future release while we wait for upstream library fixes.",
    ].join("\n"),
  },
);

server.registerTool(
  "extract_transcript",
  {
    title: "Extract a YouTube transcript",
    description:
      "Pulls the transcript of a YouTube video and returns it as Markdown with timestamps. Use this whenever the user provides a YouTube URL and wants to summarise, quote, search, or otherwise process the video's spoken content.\n\n" +
      "Costs credits on first fetch (1 credit ≤15min, 2 credits 15–45min, 4 credits 45min–2h, 8 credits 2h+). Cached extractions are free — videos other Scribefy users have already extracted are cached for 30 days.\n\n" +
      "Returns the title, channel, duration, language, and the transcript itself split into segments with clickable timestamps.",
    inputSchema: {
      url: z
        .string()
        .url()
        .describe("Full YouTube URL — youtube.com/watch?v=…, youtu.be/…, or shorts. Required."),
      lang: z
        .string()
        .min(2)
        .max(16)
        .regex(/^[a-zA-Z-]+$/)
        .describe(
          "BCP-47 language code for the captions (e.g. 'en', 'es', 'fr', 'zh-Hans'). Defaults to 'en' if omitted.",
        )
        .optional(),
    },
  },
  async ({ url, lang }) => {
    // No usable key → return setup guidance instead of a doomed API call.
    const guard = keyGuard();
    if (guard) return guard;

    let response: Response;
    try {
      response = await fetch(`${apiBase}/api/extract`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ url, lang: lang ?? "en" }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Network error talking to Scribefy at ${apiBase}: ${msg}`,
          },
        ],
      };
    }

    if (!response.ok) {
      let body: ApiErrorBody = {};
      try {
        body = (await response.json()) as ApiErrorBody;
      } catch {
        /* response had no JSON body — fall back to status-only message */
      }
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: explainApiError(response.status, body),
          },
        ],
      };
    }

    const result = (await response.json()) as ExtractResponse;
    return {
      content: [
        {
          type: "text",
          text: renderTranscript(result),
        },
      ],
    };
  },
);

// ============================================================================
// Research toolkit — five free tools added in v0.3.0 that turn the MCP from
// "transcript extractor" into "YouTube research assistant". All five hit
// auth-gated but credit-free endpoints on the Scribefy API.
// ============================================================================

interface VideoSummary {
  videoId: string;
  title: string;
  channel: string;
  channelId: string;
  durationSec: number;
  thumbnailUrl: string;
  viewCount: number;
  publishedText: string;
}

interface CaptionTrackInfo {
  languageCode: string;
  languageName: string;
  isAutoGenerated: boolean;
  isTranslatable: boolean;
}

interface VideoInfoResponse {
  videoId: string;
  title: string;
  channel: string;
  channelId: string;
  durationSec: number;
  description: string;
  thumbnailUrl: string;
  viewCount: number;
  uploadDate: string;
  isLive: boolean;
  captionTracks: CaptionTrackInfo[];
}

/**
 * Tiny POST helper: shared auth + JSON + error handling so the
 * research-toolkit tools stay terse. Returns either the decoded JSON
 * body or a `{ error: <code>, status: <http> }` object the caller renders.
 */
async function callApi<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T | { error: string; status: number; detail?: string }> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      error: "NETWORK",
      status: 0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (!response.ok) {
    let errBody: ApiErrorBody = {};
    try {
      errBody = (await response.json()) as ApiErrorBody;
    } catch {
      /* leave empty */
    }
    return {
      error: errBody.error ?? `HTTP_${response.status}`,
      status: response.status,
    };
  }

  return (await response.json()) as T;
}

/** Format a duration as M:SS or H:MM:SS. */
function durationLabel(sec: number): string {
  return fmtTime(sec);
}

/** Format a view count compactly: 12.3K, 4.2M, 583. */
function viewCountLabel(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Render a `VideoSummary[]` as a numbered Markdown list. */
function renderVideoList(results: VideoSummary[], heading: string): string {
  if (results.length === 0) return `# ${heading}\n\nNo results.`;
  const lines: string[] = [`# ${heading}`, ""];
  for (let i = 0; i < results.length; i++) {
    const v = results[i]!;
    lines.push(`${i + 1}. **${v.title}**`);
    lines.push(`   - Channel: ${v.channel || "(unknown)"}`);
    lines.push(`   - Duration: ${durationLabel(v.durationSec)}`);
    if (v.viewCount > 0) {
      lines.push(`   - Views: ${viewCountLabel(v.viewCount)}`);
    }
    if (v.publishedText) {
      lines.push(`   - Published: ${v.publishedText}`);
    }
    lines.push(`   - URL: https://www.youtube.com/watch?v=${v.videoId}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Render full VideoInfo (the get_video_metadata tool's output). */
function renderVideoInfo(info: VideoInfoResponse): string {
  const lines: string[] = [];
  lines.push(`# ${info.title}`);
  lines.push("");
  lines.push(`**Channel:** ${info.channel || "(unknown)"}`);
  lines.push(`**Duration:** ${durationLabel(info.durationSec)}`);
  if (info.viewCount > 0) lines.push(`**Views:** ${viewCountLabel(info.viewCount)}`);
  if (info.uploadDate) lines.push(`**Uploaded:** ${info.uploadDate}`);
  if (info.isLive) lines.push(`**Status:** 🔴 Live`);
  lines.push(`**URL:** https://www.youtube.com/watch?v=${info.videoId}`);
  lines.push("");

  if (info.captionTracks.length > 0) {
    lines.push("## Caption tracks");
    lines.push("");
    for (const t of info.captionTracks) {
      const marker = t.isAutoGenerated ? "⚙ auto-generated" : "✏ authored";
      lines.push(`- \`${t.languageCode}\` ${t.languageName} (${marker})`);
    }
    lines.push("");
  } else {
    lines.push("⚠ No caption tracks available — `extract_transcript` will fail on this video.");
    lines.push("");
  }

  if (info.description) {
    lines.push("## Description");
    lines.push("");
    lines.push(info.description);
  }

  return lines.join("\n");
}

/** Key guard shared by ALL tools. Returns null when a usable key is present
 *  (proceed to the API call), or a ready-to-return MCP response carrying setup
 *  guidance when the key is missing or malformed. Every Scribefy endpoint is
 *  auth-gated, so without a valid-shaped key there's nothing a tool can do. */
function keyGuard(): null | { content: Array<{ type: "text"; text: string }> } {
  if (keyMissing) return { content: [{ type: "text", text: NO_KEY_MESSAGE }] };
  if (keyWrongShape) return { content: [{ type: "text", text: BAD_KEY_SHAPE_MESSAGE }] };
  return null;
}

// ----- search_videos -----------------------------------------------------

server.registerTool(
  "search_videos",
  {
    title: "Search YouTube videos by free-text query",
    description:
      "Search YouTube for videos matching a query string. Returns up to `limit` results (default 10, max 25) with title, channel, duration, view count, and URL. Free — no credits charged. Use this when the user asks 'find me videos about X' before chaining into extract_transcript on a specific result.",
    inputSchema: {
      query: z
        .string()
        .min(1)
        .max(200)
        .describe("Free-text search query. Same syntax YouTube's own search bar accepts."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(25)
        .describe("Max results to return (1–25, default 10).")
        .optional(),
    },
  },
  async ({ query, limit }) => {
    const guard = keyGuard();
    if (guard) return guard;

    const res = await callApi<{ results: VideoSummary[] }>("/api/search", { query, limit });
    if ("error" in res) {
      return {
        isError: true,
        content: [{ type: "text", text: explainApiError(res.status, { error: res.error }) }],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: renderVideoList(res.results, `Search results for "${query}"`),
        },
      ],
    };
  },
);

// NOTE — `list_channel_videos` is intentionally NOT registered in 0.3.0.
// Upstream youtubei.js can't currently issue the channel-videos browse
// request (YouTube returns HTTP 400 to its payload shape, as of 2026-05).
// We'll reintroduce the tool once the library publishes a fix; for now
// keeping it absent so the LLM doesn't waste turns trying a broken tool.

// ----- get_video_metadata -----------------------------------------------

server.registerTool(
  "get_video_metadata",
  {
    title: "Get metadata for a YouTube video (no transcript)",
    description:
      "Look up title, channel, duration, view count, upload date, and available caption tracks for a video. Does NOT pull the transcript — use extract_transcript for that. Free — no credits charged. Useful to inspect a video before deciding whether to extract, or to discover which caption languages are available.",
    inputSchema: {
      url: z
        .string()
        .url()
        .describe("Full YouTube URL (youtube.com/watch?v=…, youtu.be/…, or shorts)."),
    },
  },
  async ({ url }) => {
    const guard = keyGuard();
    if (guard) return guard;

    const res = await callApi<VideoInfoResponse>("/api/info", { url });
    if ("error" in res) {
      return {
        isError: true,
        content: [{ type: "text", text: explainApiError(res.status, { error: res.error }) }],
      };
    }
    return {
      content: [{ type: "text", text: renderVideoInfo(res) }],
    };
  },
);

// ----- get_related_videos -----------------------------------------------

server.registerTool(
  "get_related_videos",
  {
    title: "Get YouTube's \"Up next\" feed for a video",
    description:
      "Return the videos YouTube recommends after a given video — the 'Up next' / 'Related' feed. Returns up to `limit` results (default 10, max 25). Free — no credits charged. Use this to expand research from a single starting video, or to find adjacent content.",
    inputSchema: {
      url: z
        .string()
        .url()
        .describe("Full YouTube URL of the seed video."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(25)
        .describe("Max related videos to return (1–25, default 10).")
        .optional(),
    },
  },
  async ({ url, limit }) => {
    const guard = keyGuard();
    if (guard) return guard;

    const res = await callApi<{ results: VideoSummary[] }>("/api/related", { url, limit });
    if ("error" in res) {
      return {
        isError: true,
        content: [{ type: "text", text: explainApiError(res.status, { error: res.error }) }],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: renderVideoList(res.results, "Related videos"),
        },
      ],
    };
  },
);

// NOTE — `get_video_comments` is intentionally NOT registered in 0.3.0.
// Upstream youtubei.js does not currently attach `info.getComments()` to
// the parsed VideoInfo (response shape change YouTube made in 2026-05).
// Will reintroduce once the library lands the fix.

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // No further output on stdout — stdio is owned by the MCP transport.
  // Log to stderr so MCP host UIs (Claude Desktop, Cursor) show this.
  console.error("scribefy-mcp: ready");
}

main().catch((err) => {
  console.error("scribefy-mcp: fatal error", err);
  process.exit(1);
});
