#!/usr/bin/env node
// Keep server.json's version in lockstep with package.json. Run automatically
// by the npm `version` lifecycle (see package.json "version" script), so a
// single `npm version <patch|minor|x.y.z>` bumps both files in one commit and
// the publish-mcp.yml version guard always passes.
//
// Paths are resolved relative to THIS file (not cwd), so it works no matter
// where npm invokes it from.
import { readFileSync, writeFileSync } from "node:fs";

const pkgUrl = new URL("../package.json", import.meta.url);
const serverUrl = new URL("../server.json", import.meta.url);

const pkg = JSON.parse(readFileSync(pkgUrl, "utf8"));
const server = JSON.parse(readFileSync(serverUrl, "utf8"));

server.version = pkg.version;
if (Array.isArray(server.packages)) {
  for (const p of server.packages) p.version = pkg.version;
}

writeFileSync(serverUrl, JSON.stringify(server, null, 2) + "\n");
console.log(`sync-version: server.json -> ${pkg.version}`);
