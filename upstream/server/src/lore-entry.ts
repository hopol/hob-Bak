import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const entry = new URL("../../vendor/lore-pi-extension/index.ts", import.meta.url).href;
const { default: loreExtension } = await import(entry);

export default function (pi: ExtensionAPI) {
  const api = pi as ExtensionAPI & { pluginConfig?: Record<string, unknown> };
  api.pluginConfig = { ...api.pluginConfig, injectPromptGuidance: false };
  return loreExtension(pi);
}
