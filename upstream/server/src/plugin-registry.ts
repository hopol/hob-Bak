import type { PluginConfig, PluginConfigField } from "./plugin-config.ts";

type ObjectValue = Record<string, unknown>;
const record = (value: unknown): value is ObjectValue => !!value && typeof value === "object" && !Array.isArray(value);
const keyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Convert one MCP Registry server entry; index discovery is deliberately separate. */
export function registryServerToPlugin(server: ObjectValue): { manifest: ObjectValue; mcp: ObjectValue } {
  const rawName = server.name;
  if (typeof rawName !== "string" || !rawName) throw new Error("server.json 缺少 name");
  const id = rawName.split("/").pop()!.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (!id) throw new Error("server.json 的 name 无效");
  const rejectRepeated = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(rejectRepeated);
    else if (record(value)) {
      if (value.isRepeated === true) throw new Error("server.json 的 isRepeated 暂不支持");
      Object.values(value).forEach(rejectRepeated);
    }
  };
  rejectRepeated(server);
  const config: PluginConfig = Object.create(null);
  const add = (key: string, input: ObjectValue): string => {
    if (!keyPattern.test(key)) throw new Error(`配置项名称 ${key} 不受支持`);
    const format = input.format ?? "string";
    const type = format === "filepath" ? "file" : format;
    if (!["string", "number", "boolean", "file"].includes(String(type))) throw new Error(`配置项 ${key} 的 format 不受支持：${String(format)}`);
    const field: PluginConfigField = { type: type as PluginConfigField["type"], title: key };
    if (typeof input.description === "string") field.description = input.description;
    if (input.isRequired === true) field.required = true;
    if (input.isSecret === true) field.sensitive = true;
    if (input.default !== undefined) field.default = input.default as PluginConfigField["default"];
    if (Array.isArray(input.choices)) field.options = input.choices as PluginConfigField["options"];
    if (Object.hasOwn(config, key) && JSON.stringify(config[key]) !== JSON.stringify(field)) throw new Error(`配置项 ${key} 有互相冲突的定义`);
    config[key] = field;
    return `\${user_config.${key}}`;
  };
  const template = (value: string, variables: unknown, location: string): string => value.replace(/\{([^{}]+)\}/g, (_match, key: string) => {
    if (!record(variables) || !record(variables[key])) throw new Error(`${location} 缺少变量 ${key} 的定义`);
    return add(key, variables[key]);
  });
  const inputs = (list: unknown, location: string): Record<string, string> => {
    if (list === undefined) return {};
    if (!Array.isArray(list)) throw new Error(`${location} 必须是数组`);
    return Object.fromEntries(list.map((input: unknown) => {
      if (!record(input) || typeof input.name !== "string" || !input.name) throw new Error(`${location} 缺少名称`);
      const value = typeof input.value === "string" ? template(input.value, input.variables, `${location}.${input.name}`) : add(input.name, input);
      return [input.name, value];
    }));
  };
  const remotes = Array.isArray(server.remotes) ? server.remotes.filter(record) : [];
  const remote = remotes.find(item => item.type === "streamable-http") ?? remotes.find(item => item.type === "http");
  let entry: ObjectValue;
  if (remote) {
    if (typeof remote.url !== "string") throw new Error("远程服务缺少 url");
    entry = { url: template(remote.url, remote.variables, "url"), headers: inputs(remote.headers, "headers") };
  } else {
    const packages = Array.isArray(server.packages) ? server.packages.filter(record) : [];
    const pkg = packages.find(item => record(item.transport) && item.transport.type === "stdio");
    if (!pkg || typeof pkg.identifier !== "string") throw new Error("没有受支持的远程服务或 stdio 包");
    if (pkg.packageArguments !== undefined || pkg.runtimeArguments !== undefined) throw new Error("packageArguments 和 runtimeArguments 暂不支持");
    const identifier = `${pkg.identifier}${typeof pkg.version === "string" && pkg.version ? `@${pkg.version}` : ""}`;
    const runners: Record<string, { command: string; args: string[] }> = {
      npm: { command: "npx", args: ["-y", identifier] },
      pypi: { command: "uvx", args: [typeof pkg.version === "string" && pkg.version ? `${pkg.identifier}==${pkg.version}` : pkg.identifier] },
    };
    if (typeof pkg.registryType !== "string" || !Object.hasOwn(runners, pkg.registryType)) throw new Error(`包类型 ${String(pkg.registryType)} 不受支持`);
    entry = { ...runners[pkg.registryType], env: inputs(pkg.environmentVariables, "environmentVariables") };
  }
  const manifest: ObjectValue = { name: id, version: typeof server.version === "string" ? server.version : "0.0.0", userConfig: config };
  if (typeof server.description === "string") manifest.description = server.description;
  if (typeof server.websiteUrl === "string") manifest.homepage = server.websiteUrl;
  return { manifest, mcp: { mcpServers: { [id]: entry } } };
}
