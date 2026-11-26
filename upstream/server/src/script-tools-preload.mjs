const call = async (name, args) => {
  const { HOB_TOOLS_URL: url, HOB_TOOLS_TOKEN: token } = process.env;
  if (!url || !token) throw new Error("不在 Hob 里运行，tools 不可用");
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ name, args }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return name === "$list" ? result : result.value;
};
globalThis.tools = new Proxy(Object.create(null), { get: (_target, name) => typeof name === "string" ? (args) => call(name, args) : undefined });
