import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PluginHost } from "../src/plugin-host.ts";
import { waitFor } from "./helpers.ts";

it("retries failed connections with backoff until the service recovers, and stops on disable", async () => {
  const home = mkdtempSync(join(tmpdir(), "hob-plugin-retry-"));
  const host = new PluginHost(home);
  let attempts = 0;
  let unavailable = true;
  const server = createServer((req, res) => {
    if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
    let text = ""; req.on("data", chunk => { text += chunk; });
    req.on("end", () => {
      const message = JSON.parse(text);
      if (message.id === undefined) { res.statusCode = 202; res.end(); return; }
      if (message.method === "initialize") {
        attempts++;
        if (unavailable) { res.statusCode = 503; res.end("temporarily unavailable"); return; }
      }
      const result = message.method === "initialize" ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } : { tools: [] };
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(31803, "127.0.0.1", resolve); });
    host.store.addCustom("sample", { url: "http://127.0.0.1:31803/mcp" });
    await host.start();
    expect(host.states("sample")[0].status).toBe("error");
    await waitFor(() => attempts >= 2, 6000);
    unavailable = false;
    await waitFor(() => host.states("sample")[0].status === "connected", 8000);
    expect(attempts).toBeGreaterThanOrEqual(3);
    unavailable = true;
    await host.reload("sample");
    const before = attempts;
    host.store.patch("sample", { enabled: false });
    await host.reload("sample");
    await new Promise(resolve => setTimeout(resolve, 1300));
    expect(attempts).toBe(before);
  } finally {
    await host.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);
