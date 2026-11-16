import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { devTeamGroup, devTeamRoles } from "../src/dev-team.ts";
import { defaultSettings, SettingsStore } from "../src/settings.ts";
import { Store } from "../src/store.ts";

const homes: string[] = [];
function home(): string {
  const value = mkdtempSync(join(tmpdir(), "hob-i18n-"));
  homes.push(value);
  return value;
}
afterEach(() => {
  for (const value of homes.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("locale-dependent defaults", () => {
  it("waits for the first locale before creating defaults and creates them once", () => {
    const value = home();
    const store = new Store(value);
    store.init();
    store.ensurePrimary();
    expect(store.globalRules()).toEqual([]);

    store.initializeDefaults("en");
    expect(store.globalRules()).toHaveLength(7);
    expect(store.globalRules().every((rule) => /^(Deleting|Sending|Stopping|Changing|Past|Before|Read)/.test(rule.text))).toBe(true);
    expect(store.assistant("hob")?.duty).toBe("Main assistant");

    store.initializeDefaults("zh-CN");
    expect(store.assistant("hob")?.duty).toBe("Main assistant");
    expect(devTeamGroup("en").name).toBe("Agile team");
    expect(devTeamRoles("en").map((role) => role.name)).toEqual(["Product owner", "Architect", "Developer", "QA", "Release"]);
  });

  it("adds Chinese to an old settings file that already has seeded content", () => {
    const value = home();
    mkdirSync(join(value, "system"), { recursive: true });
    writeFileSync(join(value, "system", "seeded.json"), JSON.stringify({ devTeam: true }));
    writeFileSync(join(value, "system", "settings.json"), JSON.stringify({ revision: 1, settings: defaultSettings("UTC") }));
    const settings = new SettingsStore(value);
    expect(settings.settings.general.locale).toBe("zh-CN");
    const saved = JSON.parse(readFileSync(join(value, "system", "settings.json"), "utf8")) as { settings: { general: { locale?: string } } };
    expect(saved.settings.general.locale).toBe("zh-CN");
  });

  it("does not assign a locale to a new settings file", () => {
    const value = home();
    const settings = new SettingsStore(value);
    expect(settings.settings.general.locale).toBeUndefined();
  });
});
