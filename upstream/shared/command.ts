// 命令的显示摘要：任务里的命令常套着 `cd 目录 &&`、`timeout 60`、`ssh 主机 'bash -lc "…"'` 这类外壳，
// 列表只有一行，外壳把真正执行的命令挤掉了。完整命令在任务详情里展开看。
export function commandSummary(command: string): string {
  let text = command.trim();
  for (;;) {
    const next = text
      .replace(/^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/, "")
      // timeout 的 -k/-s 后面跟一个值，其余选项单独一个词
      .replace(/^timeout\s+(?:-[ks]\s+\S+\s+|-\S+\s+)*\d+(?:\.\d+)?[smhd]?\s+/, "");
    if (next === text) break;
    text = next;
  }
  // ssh 到别的机器跑的，写成「主机: 命令」
  const ssh = SSH.exec(text);
  if (ssh) {
    let remote = ssh[2];
    const outer = quoted(remote);
    if (outer) {
      let [inner, tail] = outer;
      const shell = /^(?:ba)?sh\s+-l?c\s+/.exec(inner);
      const script = shell ? quoted(inner.slice(shell[0].length)) : undefined;
      if (script) inner = script[0] + script[1];
      remote = inner + tail;
    }
    text = `${ssh[1]}: ${commandSummary(remote)}`;
  }
  return text || command.trim();
}

// ssh 的选项：-o BatchMode=yes、-p 22 这类带一个值，其余单独一个词；之后是主机和要跑的命令
const SSH = /^ssh\s+(?:-[BbcDEeFIiJLlmOoPpQRSWw]\s*\S+\s+|-[46AaCfGgKkMNnqsTtVvXxYy]+\s+)*([^\s'"-]\S*)\s+(.+)$/s;

/**
 * 开头一段引号里的内容和剩下的部分。单引号里没有转义；双引号里 \" \\ \$ \` 是转义。
 * 没有收尾的引号也认（旧任务存的是截断到 120 字的命令）。
 */
function quoted(text: string): [string, string] | undefined {
  const m = /^'([^']*)'?/.exec(text) ?? /^"((?:[^"\\]|\\.)*)"?/s.exec(text);
  if (!m) return undefined;
  const inner = text[0] === '"' ? m[1].replace(/\\(["\\$`])/g, "$1") : m[1];
  return [inner, text.slice(m[0].length)];
}
