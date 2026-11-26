import { Type } from "typebox";
import type { PluginHost } from "./plugin-host.ts";
import { pluginToolName } from "./plugin-host.ts";

export function searchPluginsTool(host: PluginHost, assistantId: string) {
  return {
    name: "search_plugins",
    label: "查插件市场",
    description: "在插件市场里找能连接外部服务的插件，比如 GitHub、邮箱。返回每个插件的名称、说明，以及它在这里的状态：没安装、已安装但没给你用、待配置、已经能用。query 填服务名或要做的事，不填列出全部。",
    parameters: Type.Object({ query: Type.Optional(Type.String()) }),
    execute: async (_callId: string, { query }: { query?: string }) => {
      await host.store.sources.open();
      const installed = host.store.list();
      const catalog = host.store.catalog();
      const sources = host.store.sources.list();
      const entries = [...catalog.map(entry => ({ ...entry, plugin: installed.find(p => p.id === entry.id && p.source === entry.source) })), ...installed.filter(p => !catalog.some(entry => entry.id === p.id && entry.source === p.source)).map(plugin => ({ id: plugin.id, version: plugin.version, manifest: host.store.files(plugin.id).manifest, plugin, source: plugin.source, sourceName: plugin.sourceName ?? sources.find(source => source.id === plugin.source)?.name ?? (plugin.source === "custom" ? "自定义" : plugin.source), error: undefined }))];
      const needle = query?.trim().toLowerCase() ?? "";
      const words = needle.split(/[\s,，、]+/).filter(Boolean); // 模型常写「GitHub 查看 PR」这样的多个词，任一个词对上就算
      const rows = entries.map(entry => {
        const manifest = entry.plugin ? host.store.files(entry.id).manifest : entry.manifest;
        const name = typeof manifest.displayName === "string" ? manifest.displayName : typeof manifest.name === "string" ? manifest.name : entry.id;
        const description = typeof manifest.description === "string" ? manifest.description : "";
        const extensions = manifest.extensions as Record<string, any> | undefined;
        const categories = extensions?.["com.hob.plugins"]?.categories;
        const matches = !words.length || [entry.id, name, description, ...(Array.isArray(categories) ? categories.filter((value): value is string => typeof value === "string") : [])].some(value => words.some(word => value.toLowerCase().includes(word)));
        const plugin = entry.plugin;
        let state: string;
        let next: string;
        if (entry.error) { state = "不可安装"; next = entry.error; }
        else if (!plugin) { state = "没安装"; next = "用户在「插件 → 市场」里安装，再填配置。"; }
        else if (!plugin.enabled) { state = "已安装但没给你用"; next = `用户在「插件 → ${name}」里启用它。`; }
        else if (plugin.assistants && !plugin.assistants.includes(assistantId)) { state = "已安装但没给你用"; next = `用户在「插件 → ${name}」里把它给你用。`; }
        else {
          const services = host.states(entry.id);
          const errors = services.filter(service => service.status === "error" && service.error).map(service => service.error);
          if (services.length && services.every(service => service.status === "connected" || service.status === "idle")) { state = "已经能用"; next = `它的工具名以 ${pluginToolName(entry.id, "")} 开头。`; }
          else { state = "待配置"; next = `用户在「插件 → ${name}」里填配置。${errors.length ? ` ${errors.join("；")}` : ""}${services.some(service => service.status === "connecting") ? " 服务正在连接。" : ""}`; }
        }
        return { matches, text: `${name}：${description}\n${sources.length > 1 ? `来自「${entry.sourceName}」。\n` : ""}状态：${state}。${next}` };
      });
      const matched = rows.filter(row => row.matches);
      const results = needle && !matched.length ? `没有匹配「${query}」的插件\n${rows.map(row => row.text).join("\n\n")}` : matched.map(row => row.text).join("\n\n");
      const failures = sources.filter(source => source.error).map(source => `「${source.name}」${source.updatedAt ? "没有更新" : "读取失败"}：${source.error}`);
      const text = [...failures, results].filter(Boolean).join("\n\n");
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  };
}
