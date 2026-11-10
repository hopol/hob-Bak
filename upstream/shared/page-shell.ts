// 沙箱不允许弹窗；将用户点击的外链交给预览面板打开。离线单独打开时自行开新窗口。
const linkScript = `document.addEventListener('click',function(e){if(!e.isTrusted)return;const a=e.target.closest('a[href]');if(!a||!/^https?:\\/\\//i.test(a.getAttribute('href')||''))return;let u;try{u=new URL(a.href)}catch{return}if(!['http:','https:'].includes(u.protocol))return;e.preventDefault();if(window.parent!==window)window.parent.postMessage({type:'hob-page-link',url:u.href},'*');else window.open(u.href,'_blank','noopener')});`;
// 预览面板用 #dark / #light 传 Hob 当前的明暗；单独打开时跟随系统
// 手机上宽表格、宽图在自己的框里横向滚动：图按 viewBox 不缩到 0.75 倍以下，否则文字看不清
const fitScript = `addEventListener('DOMContentLoaded',function(){document.querySelectorAll('main table').forEach(function(t){if(t.parentElement.classList.contains('tw'))return;var w=document.createElement('div');w.className='tw';t.before(w);w.append(t)});document.querySelectorAll('main figure>svg').forEach(function(g){var v=g.viewBox&&g.viewBox.baseVal;if(v&&v.width)g.style.minWidth=Math.round(v.width*0.75)+'px'})});`;
const themeScript = `(function(){function f(){var h=location.hash;document.documentElement.classList.toggle('dark',h==='#dark'||(h!=='#light'&&matchMedia('(prefers-color-scheme: dark)').matches))}f();addEventListener('hashchange',f)})();`;

// 页面只能用内联样式和脚本，外部只允许 https 图片；不能联网取数据
const csp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: https:; media-src data: https:; font-src data:";

const css = `:root{--bg:#fff;--soft:#f5f5f2;--line:#e8e8e5;--ink:#18181a;--muted:#6d6d72;--faint:#a4a4a9;--accent:#ff6a2b;--accent-soft:#fff0e7;--ok:#1f9a5f;--ok-soft:#e8f5ee;--warn:#b7740a;--warn-soft:#fbf2df;--bad:#d92d20;--bad-soft:#fcebe9;color-scheme:light}
:root.dark{--bg:#151516;--soft:#1f1f21;--line:#2c2c2f;--ink:#ececed;--muted:#a1a1a7;--faint:#6b6b71;--accent:#ff7a42;--accent-soft:#36211a;--ok:#3cc183;--ok-soft:#15281e;--warn:#e9a53a;--warn-soft:#2c2414;--bad:#ff6b5e;--bad-soft:#321b19;color-scheme:dark}
*{box-sizing:border-box}
html{background:var(--bg);color:var(--ink);font:16px/1.75 system-ui,-apple-system,"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif;-webkit-text-size-adjust:100%;text-rendering:optimizeLegibility}
body{margin:0;padding:52px 24px 80px}
.page{max-width:760px;margin:0 auto}
.hd{margin-bottom:40px;padding-bottom:28px;border-bottom:1px solid var(--line)}
.hd h1{font-size:32px;line-height:1.25;letter-spacing:-.015em;margin:0 0 10px;font-weight:700}
.hd p{margin:0;color:var(--muted);font-size:17px;line-height:1.6}
h2{font-size:22px;line-height:1.35;letter-spacing:-.01em;margin:48px 0 14px;font-weight:700}
h3{font-size:16.5px;line-height:1.45;margin:28px 0 8px;font-weight:650}
main>h2:first-child,main>section:first-child>h2:first-child{margin-top:0}
p,ul,ol,table,pre,figure,blockquote,.note,.cards,.cols,.kpis,.steps{margin:0 0 18px}
ul,ol{padding-left:1.4em}li{margin:5px 0}li::marker{color:var(--faint)}
a{color:var(--accent);text-decoration:none;border-bottom:1px solid color-mix(in srgb,var(--accent) 35%,transparent)}
strong,b{font-weight:650}
.muted{color:var(--muted)}.accent{color:var(--accent)}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
code{font:.88em/1.5 ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;background:var(--soft);padding:.12em .4em;border-radius:5px}
pre{background:var(--soft);border-radius:12px;padding:14px 18px;overflow:auto;line-height:1.6}pre code{background:none;padding:0;font-size:13.5px}
blockquote{border-left:3px solid var(--line);padding:2px 0 2px 16px;color:var(--muted)}
hr{border:0;border-top:1px solid var(--line);margin:36px 0}
table{width:100%;border-collapse:collapse;font-size:14.5px;line-height:1.6}
.tw{overflow-x:auto;margin:0 0 18px}.tw>table{margin:0}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:13px;font-weight:600;color:var(--muted);border-bottom-width:1.5px;white-space:nowrap}
td{min-width:5.5em}
th:first-child,td:first-child{padding-left:0}th:last-child,td:last-child{padding-right:0}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.card{background:var(--soft);border-radius:14px;padding:16px 18px}.card h3{margin:0 0 6px;font-size:15.5px}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px 28px}
.cols>div>h3:first-child{margin-top:0}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.kpi{border:1px solid var(--line);border-radius:14px;padding:14px 16px 12px}
.kpi b{display:block;font-size:28px;line-height:1.2;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}.kpi span{color:var(--muted);font-size:13.5px}
.steps{list-style:none;padding:0;counter-reset:s}
.steps>li{position:relative;margin:0;padding:1px 0 20px 44px;counter-increment:s}
.steps>li::before{content:counter(s);position:absolute;left:0;top:0;width:28px;height:28px;border-radius:50%;background:var(--accent-soft);color:var(--accent);font-weight:700;font-size:14px;line-height:28px;text-align:center}
.steps>li::after{content:"";position:absolute;left:13.5px;top:34px;bottom:6px;width:1px;background:var(--line)}
.steps>li:last-child{padding-bottom:0}.steps>li:last-child::after{display:none}.steps>li>b:first-child{display:block}
.note{border-radius:12px;padding:12px 16px;background:var(--accent-soft)}.note.ok{background:var(--ok-soft)}.note.warn{background:var(--warn-soft)}.note.bad{background:var(--bad-soft)}
.card>:last-child,.note>:last-child,.cols>div>:last-child,section>:last-child{margin-bottom:0}
.tag{display:inline-block;font-size:12px;line-height:1.7;padding:0 8px;border-radius:99px;background:var(--soft);color:var(--muted);vertical-align:.08em;white-space:nowrap}
.card .tag{background:var(--bg)}
.tag.accent{background:var(--accent-soft);color:var(--accent)}.tag.ok{background:var(--ok-soft);color:var(--ok)}.tag.warn{background:var(--warn-soft);color:var(--warn)}.tag.bad{background:var(--bad-soft);color:var(--bad)}
figure{margin:28px 0;overflow-x:auto}img,svg{max-width:100%;height:auto}figure>svg,figure>img{display:block;margin:0 auto}
figcaption{color:var(--muted);font-size:13.5px;margin-top:10px;text-align:center}
svg{color:var(--ink)}svg text{fill:var(--ink);font-family:inherit;font-size:13px}
svg .box{fill:var(--bg);stroke:var(--line);stroke-width:1.5}svg .hl{fill:var(--accent-soft);stroke:var(--accent);stroke-width:1.5}
svg .line{fill:none;stroke:var(--faint);stroke-width:1.5}svg text.muted{fill:var(--muted)}svg text.accent{fill:var(--accent)}
@media (max-width:600px){body{padding:32px 18px 64px}.hd{margin-bottom:32px}.hd h1{font-size:26px}h2{font-size:19.5px;margin-top:40px}}`;

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function livePageHtml(): string {
  const script = `
(function(){
  let latest, scheduled = false, follow = true;
  addEventListener('scroll', function(){ follow = document.documentElement.scrollHeight - innerHeight - scrollY < 48; }, {passive:true});
  addEventListener('message', function(e){
    if(e.source !== parent || e.data?.type !== 'hob-page-live') return;
    latest = e.data;
    if(scheduled) return;
    scheduled = true;
    requestAnimationFrame(function(){
      scheduled = false;
      document.documentElement.classList.toggle('dark', !!latest.dark);
      document.title = latest.title || '';
      document.querySelector('.hd h1').textContent = latest.title || '';
      document.querySelector('.hd p').textContent = latest.summary || '';
      const main = document.querySelector('main');
      const template = document.createElement('template');
      template.innerHTML = (latest.html || '').replace(/<[^>]*$/, '');
      template.content.querySelectorAll('script,iframe,object,embed').forEach(function(el){el.remove()});
      template.content.querySelectorAll('*').forEach(function(el){
        Array.from(el.attributes).forEach(function(a){if(/^on/i.test(a.name)||a.name.toLowerCase()==='srcdoc'||/^\\s*javascript:/i.test(a.value))el.removeAttribute(a.name)});
      });
      main.innerHTML = template.innerHTML;
      main.querySelectorAll('table').forEach(function(t){const w=document.createElement('div');w.className='tw';t.before(w);w.append(t)});
      main.querySelectorAll('figure>svg').forEach(function(g){const v=g.viewBox&&g.viewBox.baseVal;if(v&&v.width)g.style.minWidth=Math.round(v.width*.75)+'px'});
      if(follow) scrollTo(0, document.documentElement.scrollHeight);
    });
  });
})();`;
  return pageHtml("", "", "").replace("</body>", `<script>${script}</script></body>`);
}

export function pageHtml(title: string, summary: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escape(title)}</title><script>${themeScript}${fitScript}</script><style>${css}</style></head>
<body><div class="page"><header class="hd"><h1>${escape(title)}</h1><p>${escape(summary)}</p></header>
<main>
${body}
</main></div><script>${linkScript}</script></body></html>
`;
}

