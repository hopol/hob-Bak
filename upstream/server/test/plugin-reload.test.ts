import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createApp } from "../src/http.ts";
import { makeHob } from "./helpers.ts";

it("keeps other connections and active calls alive when a plugin configuration changes", async () => {
  const hob = makeHob();
  try {
    const host = hob.runtime.plugins;
    const fixture = fileURLToPath(new URL("./fixtures/mcp-fixture.mjs", import.meta.url));
    for (const id of ["first", "second"]) {
      host.store.addCustom(id, { command: process.execPath, args: [fixture], env: { HOB_MCP_SLOW: "1" } });
      await host.reload(id);
    }
    const instance = async (id: string) => (await host.call(id, id, "instance", {})).content;
    const first = await instance("first");
    const second = await instance("second");
    const app = createApp(hob.runtime, { home: hob.home });
    const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
    const headers = { cookie: login.headers.get("set-cookie")!.split(";")[0]!, "content-type": "application/json" };
    const save = (value: string) => app.request("/api/plugins/first/config", { method: "PUT", headers, body: JSON.stringify({ values: { HOB_CUSTOM_SECRET_1: value } }) });

    expect((await save("1")).status).toBe(200);
    expect(await instance("first")).toEqual(first);
    const patch = await app.request("/api/plugins/first", { method: "PATCH", headers, body: JSON.stringify({ exposure: "deferred" }) });
    expect(patch.status).toBe(200);
    expect(await instance("first")).toEqual(first);

    const call = host.call("first", "first", "slow", {});
    let saved = false;
    const updating = save("2").then(response => { saved = true; return response; });
    await new Promise(resolve => setTimeout(resolve, 75));
    expect(saved).toBe(false);
    expect(await instance("second")).toEqual(second);
    expect((await call).content).toEqual([{ type: "text", text: "finished" }]);
    expect((await updating).status).toBe(200);
    expect(await instance("first")).not.toEqual(first);
    expect(await instance("second")).toEqual(second);
  } finally {
    await hob.runtime.plugins.close();
    hob.close();
  }
});
