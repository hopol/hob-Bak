#!/usr/bin/env node
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const validId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const json = path => JSON.parse(readFileSync(path, "utf8"));

function filesIn(root, dir = root) {
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic link is not allowed: ${path}`);
    if (stat.isDirectory()) files.push(...filesIn(root, path));
    else if (stat.isFile()) files.push(relative(root, path).split(sep).join("/"));
    else throw new Error(`Unsupported file: ${path}`);
  }
  return files;
}

const plugins = [];
let prior = [];
try { const index = json(join(root, "index.json")); if (Array.isArray(index.plugins)) prior = index.plugins.map(item => item.id); } catch { /* A new source has no index yet. */ }
for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isDirectory() || entry.name === "scripts" || entry.name.startsWith(".")) continue;
  if (!validId.test(entry.name)) throw new Error(`Invalid plugin id: ${entry.name}`);
  const dirRoot = join(root, entry.name);
  const manifest = json(join(dirRoot, "plugin.json"));
  const mcp = json(join(dirRoot, "mcp.json"));
  if (!isObject(manifest) || typeof manifest.version !== "string" || !manifest.version) throw new Error(`Invalid plugin version: ${entry.name}`);
  if (!isObject(mcp) || !isObject(mcp.mcpServers)) throw new Error(`Invalid MCP configuration: ${entry.name}`);
  plugins.push({ id: entry.name, path: entry.name, files: filesIn(dirRoot) });
}
plugins.sort((a, b) => {
  const ai = prior.indexOf(a.id), bi = prior.indexOf(b.id);
  return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi) || a.id.localeCompare(b.id);
});
writeFileSync(join(root, "index.json"), `${JSON.stringify({ name: "Hob 官方", plugins }, null, 2)}\n`);
