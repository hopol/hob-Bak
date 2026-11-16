import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("右栏定时行复用 DetailRow", () => {
  const panel = readFileSync(new URL("../src/components/Panel.tsx", import.meta.url), "utf8");
  expect(panel).toMatch(/import \{ DetailRow \} from "\.\/DetailRow\.tsx"/);
  expect(panel).toMatch(/<DetailRow[\s\S]*?openRoutine/);
});
