import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("右栏定时和事项行都复用 DetailRow", () => {
  const panel = readFileSync(new URL("../src/components/Panel.tsx", import.meta.url), "utf8");
  const projects = readFileSync(new URL("../src/components/Projects.tsx", import.meta.url), "utf8");
  expect(panel).toMatch(/import \{ DetailRow \} from "\.\/DetailRow\.tsx"/);
  expect(panel).toMatch(/<DetailRow[\s\S]*?openRoutine/);
  expect(projects).toMatch(/import \{ DetailRow \} from "\.\/DetailRow\.tsx"/);
  expect(projects).toMatch(/<DetailRow[\s\S]*?openProject/);
});
