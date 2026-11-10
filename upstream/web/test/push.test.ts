import { describe, expect, it } from "vitest";
import { base64ToBytes, deviceLabel, sameKey } from "../src/push.ts";

describe("base64ToBytes", () => {
  it("base64 和 base64url 都解成同一串字节", () => {
    const standard = base64ToBytes("APv/EA==");
    const urlsafe = base64ToBytes("APv_EA");
    expect([...standard]).toEqual([0, 251, 255, 16]);
    expect([...urlsafe]).toEqual([0, 251, 255, 16]);
  });

  it("VAPID 公钥（65 字节、无填充的 base64url）解出来长度不变", () => {
    const key = "B".repeat(87); // 87 个字符 = 65 字节
    expect(base64ToBytes(key)).toHaveLength(65);
  });
});

describe("sameKey", () => {
  it("浏览器现有订阅的公钥和服务端的一致才算同一把；拿不到就当不是", () => {
    const key = base64ToBytes("APv_EA");
    expect(sameKey(new Uint8Array([0, 251, 255, 16]).buffer, key)).toBe(true);
    expect(sameKey(new Uint8Array([0, 251, 255, 17]).buffer, key)).toBe(false);
    expect(sameKey(new Uint8Array([0, 251, 255]).buffer, key)).toBe(false);
    expect(sameKey(null, key)).toBe(false);
  });
});

describe("deviceLabel", () => {
  it("按 UA 里的显眼标记给设备命名", () => {
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15")).toBe("iPhone");
    expect(deviceLabel("Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15")).toBe("iPad");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36")).toBe("Android");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15")).toBe("Mac");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")).toBe("Windows");
    expect(deviceLabel("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36")).toBe("Linux");
    expect(deviceLabel("curl/8.5.0")).toBe("浏览器");
  });
});
