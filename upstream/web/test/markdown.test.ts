import { describe, expect, it } from "vitest";
import { hasMath, loadMath, renderMarkdown, splitTables } from "../src/markdown.ts";

describe("renderMarkdown", () => {
  it("公式异步加载后渲染，代码和钱数不受影响", async () => {
    expect(hasMath("$5 和 $10，以及 `$x$`" )).toBe(false);
    expect(hasMath("$x^2$")).toBe(true);
    await loadMath();
    for (const input of ["$x^2$", "$$x^2$$", "\\(x^2\\)", "\\[x^2\\]"]) {
      expect(renderMarkdown(input)).toContain('class="katex');
    }
    expect(renderMarkdown("$5 和 $10")).toContain("$5 和 $10");
    expect(renderMarkdown("`$x$`\n\n```\n$x$\n```")).not.toContain('class="katex');
    expect(renderMarkdown("$\\notacommand$ ")).toContain("$\\notacommand$");
    expect(renderMarkdown("$\\href{javascript:alert(1)}{bad}$")).not.toContain("<a ");
  });

  it("模板变量、Shell 变量、金额和裸中文不误匹配为行内公式", async () => {
    await loadMath();
    const repro = "删掉了「，是『${name}』指定的现成目录」，改为：工作目录：${job.cwd}：你的命令默认在这里运行，改动直接落在这里。任务自己的目录是 ${ownDir}：要另拉一份代码隔离着执行。";
    expect(hasMath(repro)).toBe(false);
    const reproHtml = renderMarkdown(repro);
    expect(reproHtml).not.toContain('class="katex');
    expect(reproHtml).toContain("${name}");
    expect(reproHtml).toContain("${job.cwd}");
    expect(reproHtml).toContain("${ownDir}");

    const nonMathCases = [
      "${a} 和 ${b}",
      "${a}和${b}",
      "${a}/${b}",
      "$HOME 到 $PATH",
      "$HOME到$PATH",
      "$HOME 和 $PATH",
      "$HOME/$PATH",
      "$10 到 $20",
      "$10到$20",
      "foo$bar$baz",
      "正则 /^foo$/ 和 /^bar$/",
      "价格 $10（原价 $20）",
      "变量以$开头，这里用$符号",
    ];
    for (const input of nonMathCases) {
      expect(hasMath(input), input).toBe(false);
      const html = renderMarkdown(input);
      expect(html, input).not.toContain('class="katex');
      expect(html, input).toContain(input);
    }

    // 模板变量与合法公式同段出现：前者原样保留，后者正常渲染
    const mixed = "目录是 ${job.cwd}，公式是 $\\alpha + \\beta$；还有 ${a}:$\\gamma$";
    expect(hasMath(mixed)).toBe(true);
    const mixedHtml = renderMarkdown(mixed);
    expect(mixedHtml).toContain("${job.cwd}");
    expect(mixedHtml).toContain("${a}:");
    expect(mixedHtml).toContain('class="katex');
  });

  it("合法单字符、中文 \\text 命令和块级公式继续正常渲染", async () => {
    await loadMath();
    const validCases = [
      "$x$",
      "$E=mc^2$",
      "$x + y$",
      "$x_1 + y_1$",
      "$\\alpha + \\beta$",
      "$\\frac{a}{b}$",
      "$a + \\text{中文}$",
      "$\\text{总价} = n \\times p$",
      "$\\mathrm{速度} = \\frac{\\text{路程}}{\\text{时间}}$",
      "令$x=1$时",
      "$a$和$b$",
      "${x}^2$",
      "CO$_2$",
      "面积 100 m$^2$",
      "转 90$^\\circ$",
      "$利润 = 收入 - 成本$",
      "$v = \\frac{路程}{时间}$",
      "\\(a+b\\)",
      "$$x^2$$",
    ];
    for (const input of validCases) {
      expect(hasMath(input), input).toBe(true);
      expect(renderMarkdown(input), input).toContain('class="katex');
    }
  });

  it("代码块显示语言和复制按钮且保留代码原文", () => {
    const result = renderMarkdown('```js\nconst x = "<&";\n```');
    expect(result).toContain('class="code-copy"');
    expect(result).toContain('<div class="code-head">js</div>');
    expect(result).toContain('const x = &quot;&lt;&amp;&quot;;');
    // 没写语言就不出语言那一行，复制按钮照样有
    const bare = renderMarkdown("```\nls\n```");
    expect(bare).not.toContain("code-head");
    expect(bare).toContain('class="code-copy"');
  });
  it("行内代码和代码块里的引号、尖括号原样显示，不双重转义", () => {
    expect(renderMarkdown('看 `sprite: "wifi"` 这段')).toContain('<code>sprite: &quot;wifi&quot;</code>');
    expect(renderMarkdown('看 `sprite: "wifi"` 这段')).not.toContain("&amp;quot;");
    expect(renderMarkdown("比较 `a < b && c > d`")).toContain("<code>a &lt; b &amp;&amp; c &gt; d</code>");
    const block = renderMarkdown('```\n<a href="x">y</a>\n```');
    expect(block).toContain("&lt;a href=&quot;x&quot;&gt;y&lt;/a&gt;");
    expect(block).not.toContain("&amp;");
    // 正文里的引号被 marked 转义成实体（浏览器里照原样显示），但不能被转义两次
    const plain = renderMarkdown("正文里写 \"引号\" 和 '单引号'");
    expect(plain).toContain("&quot;引号&quot;");
    expect(plain).not.toContain("&amp;");
  });

  it("原始 HTML 不生效，一律当文本输出", () => {
    const script = renderMarkdown("hello <script>alert(1)</script>");
    expect(script).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(script).not.toContain("<script>");
    expect(renderMarkdown("<b>粗体</b>")).toContain("&lt;b&gt;粗体&lt;/b&gt;");
    expect(renderMarkdown("<b>粗体</b>")).not.toContain("<b>");
    expect(renderMarkdown('<img src=x onerror="alert(1)">')).not.toContain("<img");
  });

  it("链接仍然生成，并且新窗口打开", () => {
    const html = renderMarkdown("[点这里](http://a.b/c)");
    expect(html).toContain('<a target="_blank" rel="noreferrer" href="http://a.b/c">点这里</a>');
  });

  it("服务器上的文件路径链接标成文件链接，不当网页新开", () => {
    expect(renderMarkdown("[报告.md](/srv/data/work/报告.md)")).toMatch(/<a class="file-link" href="\/srv\/data\/work\/[^"]+">报告.md<\/a>/);
    expect(renderMarkdown("[x](/api/files?path=a)")).toContain('target="_blank"');
  });

  it("javascript: 这类链接不生成可点的地址", () => {
    for (const bad of ["[x](javascript:alert(1))", "[x](  JaVaScRiPt:alert(1))", "[x](data:text/html,hi)"]) {
      const html = renderMarkdown(bad);
      expect(html).not.toMatch(/href=/i);
      expect(html).toContain("<a>x</a>");
    }
    expect(renderMarkdown("[信](mailto:a@b.c)")).toContain('href="mailto:a@b.c"');
  });
  it("中文标点紧挨 ** 时照样加粗（marked 15 在这里漏掉，原样显示两个星号）", () => {
    const reply = renderMarkdown("好的，**目前稳定可用的是 `node-a`、`node b`、`node c` 这三个。** `backup` 也有成功记录");
    expect(reply).toContain("<strong>目前稳定可用的是 <code>node-a</code>、<code>node b</code>、<code>node c</code> 这三个。</strong>");
    expect(renderMarkdown("- 结果：**明确 token 被拒**（401）")).toContain("<strong>明确 token 被拒</strong>");
    expect(renderMarkdown("**两层架构。**Router 长期在线")).toContain("<strong>两层架构。</strong>");
  });

  it("表格从回复里切出来单独成卡片，前后文字各成一段；代码块里的 | 不算", () => {
    const parts = splitTables("看这张：\n\n| 方式 | 适合 |\n| --- | --- |\n| 聊天 | 简单 |\n\n还有别的。");
    expect(parts.map((p) => p.table)).toEqual([false, true, false]);
    expect(parts[1].md).toContain("| 聊天 | 简单 |");
    expect(splitTables("```\n| a | b |\n| - | - |\n```").map((p) => p.table)).toEqual([false]);
    expect(splitTables("没有表格")).toEqual([{ table: false, md: "没有表格" }]);
  });
});
