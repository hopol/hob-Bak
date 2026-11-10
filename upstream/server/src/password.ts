// 登录密码：config.json 只存哈希（scrypt + 每组随机盐），不存明文。
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEYLEN = 64;

/** "scrypt$salt$hash"，salt 和 hash 都是 hex。 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEYLEN).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function isPasswordHash(value: string): boolean {
  return /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(value);
}

export function verifyPassword(stored: string, password: string): boolean {
  if (!isPasswordHash(stored)) return false;
  const [, salt, hash] = stored.split("$");
  const expected = Buffer.from(hash, "hex");
  const given = scryptSync(password, salt, KEYLEN);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
