import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyNetworkProxy, DEFAULT_NO_PROXY, checkProxy, proxyEnvironment } from "../src/network-proxy.ts";
import { SettingsStore } from "../src/settings.ts";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  applyNetworkProxy("", DEFAULT_NO_PROXY);
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

describe("network proxy settings", () => {
  it("uses the default noProxy list and rejects unsupported proxy URLs", () => {
    const home = mkdtempSync(join(tmpdir(), "hob-proxy-settings-"));
    try {
      const settings = new SettingsStore(home);
      expect(settings.settings.general.proxy).toBe("");
      expect(settings.settings.general.noProxy).toBe(DEFAULT_NO_PROXY);
      const saved = settings.patch(settings.get().revision, { general: { proxy: "https://user:pass@example.test:8443" } });
      expect(saved?.settings.general.proxy).toBe("https://user:pass@example.test:8443");
      expect(() => settings.patch(saved!.revision, { general: { proxy: "socks5://127.0.0.1:1080" } })).toThrow("代理地址要以 http:// 或 https:// 开头");
      expect(checkProxy("  http://127.0.0.1:7890  ")).toBe("http://127.0.0.1:7890");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("passes the same proxy variables to child environments and preserves inherited values when disabled", () => {
    const inherited = { PATH: "/bin", HTTP_PROXY: "http://inherited.test:8080" };
    expect(proxyEnvironment(inherited, { proxy: "", noProxy: DEFAULT_NO_PROXY })).toEqual(inherited);
    expect(proxyEnvironment({ PATH: "/bin" }, { proxy: "http://proxy.test:8080", noProxy: DEFAULT_NO_PROXY })).toMatchObject({
      HTTP_PROXY: "http://proxy.test:8080",
      HTTPS_PROXY: "http://proxy.test:8080",
      ALL_PROXY: "http://proxy.test:8080",
      NO_PROXY: DEFAULT_NO_PROXY,
      http_proxy: "http://proxy.test:8080",
      https_proxy: "http://proxy.test:8080",
      all_proxy: "http://proxy.test:8080",
      no_proxy: DEFAULT_NO_PROXY,
    });
  });

  it("routes global fetch through the proxy and restores direct fetch when cleared", async () => {
    let proxyHits = 0;
    let targetHits = 0;
    const target = createServer((_request, response) => { targetHits++; response.end("target"); });
    const targetPort = await listen(target);
    const proxy = createServer((_request, response) => { proxyHits++; response.end("proxy"); });
    const proxyPort = await listen(proxy);

    applyNetworkProxy(`http://127.0.0.1:${proxyPort}`, "");
    expect(await (await fetch(`http://127.0.0.1:${targetPort}/via-proxy`)).text()).toBe("proxy");
    expect(proxyHits).toBe(1);
    expect(targetHits).toBe(0);

    applyNetworkProxy("", DEFAULT_NO_PROXY);
    expect(await (await fetch(`http://127.0.0.1:${targetPort}/direct`)).text()).toBe("target");
    expect(targetHits).toBe(1);
  });
});
