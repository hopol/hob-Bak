const id = process.env.DESKTOP_SCREEN;
const token = process.env.DESKTOP_DOCK_TOKEN;
if (!id || !token) throw new Error("缺少屏幕或令牌");
const base = `http://127.0.0.1:${process.env.DESKTOP_PORT || 6080}/api/screens/${id}/browser`;
for (const action of ["start", "focus"]) {
  const response = await fetch(`${base}/${action}`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`${action}: ${response.status} ${await response.text()}`);
}
