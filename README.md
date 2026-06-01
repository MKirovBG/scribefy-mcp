# scribefy-mcp

[MCP](https://modelcontextprotocol.io) server for [Scribefy](https://scribefy.app) — extract YouTube transcripts from Claude Desktop, Cursor, Windsurf, ChatGPT custom GPTs, or any other MCP-compatible client.

> **Live now** — set it up in a minute below, or try the web app at **[scribefy.app](https://scribefy.app)**.

## Why

Most YouTube transcript tools live in browser extensions or one-off web UIs. This wraps Scribefy's API into the MCP standard so your AI assistant can pull a transcript whenever a user pastes a YouTube link — no manual copy-paste, no separate tabs.

## Requirements

- Node 20+
- A Scribefy account on the **API + MCP** plan ($25/mo) for an API key. You can install without a key first — the MCP host registers the server cleanly and you'll get a friendly nudge when you try to use a tool — then add your key from [scribefy.app/dashboard](https://scribefy.app/dashboard) to start extracting.

## Setup

### Claude Desktop

Open the config file (`Settings → Developer → Edit Config`):

```json
{
  "mcpServers": {
    "scribefy": {
      "command": "npx",
      "args": ["-y", "scribefy-mcp"],
      "env": {
        "SCRIBEFY_API_KEY": "sk_live_…"
      }
    }
  }
}
```

Restart Claude Desktop. The `extract_transcript` tool appears in the available-tools panel.

### Cursor

`Settings → Cursor Settings → MCP → Add new MCP server`:

```json
{
  "scribefy": {
    "command": "npx",
    "args": ["-y", "scribefy-mcp"],
    "env": {
      "SCRIBEFY_API_KEY": "sk_live_…"
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "scribefy": {
      "command": "npx",
      "args": ["-y", "scribefy-mcp"],
      "env": {
        "SCRIBEFY_API_KEY": "sk_live_…"
      }
    }
  }
}
```

### Anywhere else

Any MCP host that supports stdio transport: spawn `npx -y scribefy-mcp` with `SCRIBEFY_API_KEY` in the env. The server speaks the standard [MCP](https://modelcontextprotocol.io) JSON-RPC over stdin/stdout.

## Tools exposed

Four tools. Three are free (research toolkit); only `extract_transcript` charges credits.

### `extract_transcript`

Pulls the transcript of a YouTube video.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | Full YouTube URL — `youtube.com/watch?v=…`, `youtu.be/…`, or `youtube.com/shorts/…` |
| `lang` | string | no | BCP-47 language code (e.g. `en`, `es`, `fr`, `zh-Hans`). Defaults to `en` |

**Returns:** Markdown with title, channel, duration, language, and the transcript split into segments with timestamps.

**Cost:** 1 credit (≤15 min) → 8 credits (2 h+). Cached transcripts are free.

### `search_videos`

Free-text YouTube search.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Search query — same syntax YouTube's own search bar accepts |
| `limit` | number | no | Max results, 1–25 (default 10) |

**Returns:** Markdown list of title / channel / duration / views / URL for each result.

**Cost:** Free.

### `get_video_metadata`

Title, channel, duration, view count, upload date, and available caption tracks. **Does not** pull the transcript.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | Full YouTube URL |

**Returns:** Markdown summary plus a list of every caption track (authored ✏ or auto-generated ⚙) with its language code.

**Cost:** Free. Use this to inspect a video before deciding whether to extract, or to discover which caption languages are available.

### `get_related_videos`

YouTube's "Up next" feed for a video.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | Full YouTube URL of the seed video |
| `limit` | number | no | Max related videos, 1–25 (default 10) |

**Returns:** Same shape as `search_videos`.

**Cost:** Free.

### Tools coming in a future release

`list_channel_videos` and `get_video_comments` were planned for 0.3.0 but are deferred to 0.4.0 while we wait for upstream `youtubei.js` to publish fixes for YouTube's 2026 response-shape changes. Channel listing fails with HTTP 400 at the InnerTube layer, and `info.getComments()` is no longer attached to parsed `VideoInfo`. Both will return as soon as the library catches up.

## Configuration

| Env var | Required | Default | Notes |
|---|---|---|---|
| `SCRIBEFY_API_KEY` | yes | — | `sk_live_…` (production) or `sk_test_…` (Scribefy test mode) |
| `SCRIBEFY_API_BASE` | no | `https://api.scribefy.app` | Override for staging (`https://api-staging.scribefy.app`) or self-hosted instances |

## Troubleshooting

**`SCRIBEFY_API_KEY is required`**
Make sure the `env` block is set in your MCP host's config and the host actually loads it. Some hosts strip env vars by default — check their docs.

**`Scribefy rejected the API key`**
Either the key is wrong, the key was revoked, or your subscription is no longer on the API + MCP plan. Check [scribefy.app/dashboard](https://scribefy.app/dashboard).

**`Not enough credits`**
The tool returns the remaining balance and the cost in the error message. Top up at [scribefy.app/pricing](https://scribefy.app/pricing).

**The tool doesn't show up in my MCP client**
After editing the config, fully restart the client (not just the chat window). Tail the client's logs if available — most show MCP stderr there. The server prints `scribefy-mcp: ready` once it boots.

## License

MIT
