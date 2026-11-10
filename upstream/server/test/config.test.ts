import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, setPassword } from "../src/config.ts";

describe("config.json", () => {
  it("只给自己读写：首次创建和改密码后都是 0600", () => {
    const home = mkdtempSync(join(tmpdir(), "hob-config-"));
    const config = loadConfig(home, { HOB_PASSWORD: "first-pass" });
    const mode = () => statSync(join(home, "system", "config.json")).mode & 0o777;
    expect(mode()).toBe(0o600);
    setPassword(home, config, "secret-pass");
    expect(mode()).toBe(0o600);
  });

  it("数据目录只给自己：已有的 0755 目录启动时也收紧成 0700", () => {
    const home = mkdtempSync(join(tmpdir(), "hob-config-"));
    chmodSync(home, 0o755);
    loadConfig(home, { HOB_PASSWORD: "first-pass" });
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });
});
