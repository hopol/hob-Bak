// 设置 → 消耗：从会话文件统计的请求、token 和估算花费（数据来源见 docs/architecture.md“消耗”）。
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { TokenPrice, UsageModelPrice, UsagePrices, UsageRow, UsageView } from "../../../shared/types.ts";
import { DelayedText, Empty } from "./Empty.tsx";
import { Group, PageHead, Seg } from "./SettingsParts.tsx";
import { loadUsage, saveUsagePrice, useApp } from "../store.ts";
import { fmtWhen } from "../util.ts";

const USAGE_RANGES = [
  { key: "today", label: "今天", days: 1 },
  { key: "week", label: "近 7 天", days: 7 },
  { key: "month", label: "近 30 天", days: 30 },
  { key: "all", label: "全部", days: 0 },
] as const;
type UsageRange = (typeof USAGE_RANGES)[number]["key"];
type UsageMetric = "requests" | "tokens" | "cost";
type PriceFields = Record<keyof TokenPrice, string>;

const USAGE_METRICS: { key: UsageMetric; label: string }[] = [
  { key: "requests", label: "请求" },
  { key: "tokens", label: "Token" },
  { key: "cost", label: "花费" },
];
const METRIC_TEXT: Record<UsageMetric, string> = { requests: "按请求次数着色", tokens: "按 Token 数着色", cost: "按花费着色" };
const PRICE_FIELDS: { key: keyof TokenPrice; label: string }[] = [
  { key: "input", label: "输入" },
  { key: "output", label: "输出" },
  { key: "cacheRead", label: "缓存读" },
  { key: "cacheWrite", label: "缓存写" },
];

/** 设置时区下的今天（YYYY-MM-DD）。 */
function usageToday(timezone: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** 从今天往前数 count 天（含今天）的日期；按日历走，与时区偏移无关。 */
function usageDays(today: string, count: number): string[] {
  const base = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => new Date(base - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10));
}

/** 周几：0 = 周一（热力图从周一开始铺）。 */
function usageWeekday(day: string): number {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/** 「11月6日 周五」 */
function usageDayText(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const month = new Intl.DateTimeFormat("zh-CN", { timeZone: "UTC", month: "long", day: "numeric" }).format(date);
  const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone: "UTC", weekday: "short" }).format(date);
  return `${month} ${weekday}`;
}

/** token 数：1.2K / 38.2M。 */
function usageCount(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e4) return `${Math.round(value / 1e3)}K`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}

function usageMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

function usagePercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** 一行用掉多少钱（美元）：四项 token 各乘自己的单价，再除以一百万。 */
function usageRowCost(row: UsageRow, price: TokenPrice): number {
  return (row.input * price.input + row.output * price.output + row.cacheRead * price.cacheRead + row.cacheWrite * price.cacheWrite) / 1e6;
}

/** 输入侧 token（含缓存读和缓存写）。 */
function usageInput(row: UsageRow): number {
  return row.input + row.cacheRead + row.cacheWrite;
}

interface UsageTotals {
  requests: number;
  input: number; // 含缓存读写
  output: number;
  cacheRead: number;
  cost: number;
  unpriced: number; // 没价格的模型个数
}

function usageTotals(rows: UsageRow[], prices: UsagePrices): UsageTotals {
  const totals: UsageTotals = { requests: 0, input: 0, output: 0, cacheRead: 0, cost: 0, unpriced: 0 };
  const unpriced = new Set<string>();
  for (const row of rows) {
    totals.requests += row.requests;
    totals.input += usageInput(row);
    totals.output += row.output;
    totals.cacheRead += row.cacheRead;
    const price = prices.models[row.model]?.price;
    if (price) totals.cost += usageRowCost(row, price);
    else unpriced.add(row.model);
  }
  totals.unpriced = unpriced.size;
  return totals;
}

/** 价格表的状态：拉取失败时如实写原因和用的是哪天的。 */
function priceNote(prices: UsagePrices): string | null {
  if (prices.error) {
    return prices.updatedAt
      ? `价格表更新失败：${prices.error}，用的是 ${fmtWhen(prices.updatedAt)} 的。`
      : `价格表还没有拉到过：${prices.error}，所有模型都先按未定价算。`;
  }
  return prices.updatedAt ? null : "还没有拉到价格表，所有模型都先按未定价算。";
}

export function UsageSection() {
  const [view, setView] = useState<UsageView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void loadUsage().then((result) => {
      if (!alive) return;
      if (result.ok) setView(result.view);
      else setError(result.error);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <>
        <PageHead title="消耗" desc="对话和任务用掉的 token 和花费，按服务商返回的用量统计；花费按模型价格估算，以服务商账单为准。" />
        <div className="badline" role="status">{error}</div>
      </>
    );
  }
  if (!view) return <Empty><DelayedText text="正在统计会话用量…" /></Empty>;
  return <UsagePage view={view} />;
}

function UsagePage({ view }: { view: UsageView }) {
  const s = useApp();
  const [prices, setPrices] = useState<UsagePrices>(view.prices);
  const [range, setRange] = useState<UsageRange>("month");
  const [metric, setMetric] = useState<UsageMetric>("requests");
  const [hover, setHover] = useState<string | null>(null);
  const heatScroll = useRef<HTMLDivElement | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [fields, setFields] = useState<PriceFields>({ input: "", output: "", cacheRead: "", cacheWrite: "" });
  const [busy, setBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const today = usageToday(view.timezone);
  const year = useMemo(() => usageDays(today, 365), [today]);
  const rangeItem = USAGE_RANGES.find((item) => item.key === range) ?? USAGE_RANGES[2];
  const rangeDays = rangeItem.days;
  const rangeLabel = rangeItem.label;

  /** 每一天的合计：热力图着色、日均都用它。 */
  const perDay = useMemo(() => {
    const map = new Map<string, { requests: number; tokens: number; cost: number }>();
    for (const row of view.rows) {
      const entry = map.get(row.day) ?? { requests: 0, tokens: 0, cost: 0 };
      entry.requests += row.requests;
      entry.tokens += usageInput(row) + row.output;
      const price = prices.models[row.model]?.price;
      if (price) entry.cost += usageRowCost(row, price);
      map.set(row.day, entry);
    }
    return map;
  }, [view.rows, prices]);

  const current = useMemo(() => {
    const start = rangeDays ? usageDays(today, rangeDays)[0] : "";
    return view.rows.filter((row) => !start || row.day >= start);
  }, [view.rows, rangeDays, today]);
  const totals = useMemo(() => usageTotals(current, prices), [current, prices]);
  const previous = useMemo(() => {
    if (!rangeDays) return null;
    const start = usageDays(today, rangeDays)[0];
    const before = usageDays(today, rangeDays * 2)[0];
    return usageTotals(view.rows.filter((row) => row.day >= before && row.day < start), prices);
  }, [view.rows, prices, rangeDays, today]);

  /** 日均按这个范围的天数算；「全部」按头一条记录那天到今天。 */
  const spanDays = useMemo(() => {
    if (rangeDays) return rangeDays;
    const first = view.rows.reduce<string | null>((earliest, row) => (!earliest || row.day < earliest ? row.day : earliest), null);
    if (!first) return 1;
    return Math.max(1, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) + 1);
  }, [view.rows, rangeDays, today]);

  const modelRows = useMemo(() => {
    const byModel = new Map<string, { requests: number; input: number; output: number; cacheRead: number; providers: Map<string, number>; priced: boolean; cost: number }>();
    for (const row of current) {
      const entry = byModel.get(row.model) ?? { requests: 0, input: 0, output: 0, cacheRead: 0, providers: new Map<string, number>(), priced: false, cost: 0 };
      entry.requests += row.requests;
      entry.input += usageInput(row);
      entry.output += row.output;
      entry.cacheRead += row.cacheRead;
      const tokens = usageInput(row) + row.output;
      entry.providers.set(row.provider, (entry.providers.get(row.provider) ?? 0) + tokens);
      const price = prices.models[row.model]?.price;
      if (price) {
        entry.priced = true;
        entry.cost += usageRowCost(row, price);
      }
      byModel.set(row.model, entry);
    }
    return [...byModel]
      .map(([model, entry]) => ({
        model,
        provider: [...entry.providers].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "",
        requests: entry.requests,
        input: entry.input,
        output: entry.output,
        cacheRead: entry.cacheRead,
        cost: entry.priced ? entry.cost : null,
        price: prices.models[model],
      }))
      .sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.requests - a.requests);
  }, [current, prices]);

  const whoRows = useMemo(() => {
    const byAssistant = new Map<string, { chat: number; job: number; requests: number }>();
    for (const row of current) {
      const entry = byAssistant.get(row.assistantId) ?? { chat: 0, job: 0, requests: 0 };
      const price = prices.models[row.model]?.price;
      if (price) entry[row.source === "chat" ? "chat" : "job"] += usageRowCost(row, price);
      entry.requests += row.requests;
      byAssistant.set(row.assistantId, entry);
    }
    return view.assistants
      .map((assistant) => {
        const entry = byAssistant.get(assistant.id) ?? { chat: 0, job: 0, requests: 0 };
        return { ...assistant, ...entry, cost: entry.chat + entry.job };
      })
      .filter((row) => row.requests > 0)
      .sort((a, b) => b.cost - a.cost);
  }, [current, prices, view.assistants]);

  /** 热力图：最近一年，一周一列，周一开始。 */
  const heat = useMemo(() => {
    const cells: (string | null)[] = [...Array.from({ length: usageWeekday(year[0]) }, () => null), ...year];
    while (cells.length % 7) cells.push(null);
    const weeks: (string | null)[][] = [];
    for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
    const value = (day: string) => {
      const entry = perDay.get(day);
      return entry ? entry[metric] : 0;
    };
    const max = Math.max(0, ...year.map(value));
    const level = (day: string) => {
      const amount = value(day);
      if (amount <= 0) return 0;
      if (amount < max * 0.2) return 1;
      if (amount < max * 0.45) return 2;
      if (amount < max * 0.7) return 3;
      return 4;
    };
    const months: string[] = [];
    let lastMonth = 0;
    let lastAt = -9;
    weeks.forEach((week, index) => {
      const last = [...week].reverse().find((day): day is string => Boolean(day));
      const month = last ? Number(last.slice(5, 7)) : lastMonth;
      const label = month !== lastMonth && index - lastAt > 2;
      months.push(label ? `${month}月` : "");
      if (label) lastAt = index;
      lastMonth = month;
    });
    return { weeks, level, months };
  }, [year, perDay, metric]);

  /** 手机上一年放不下一屏，停在最右边（今天）；桌面放得下，不动。宽度变了（转屏）也跟着回到今天。 */
  useLayoutEffect(() => {
    const el = heatScroll.current;
    if (!el) return;
    const pinRight = () => {
      el.scrollLeft = el.scrollWidth - el.clientWidth;
    };
    pinRight();
    const observer = new ResizeObserver(pinRight);
    observer.observe(el);
    return () => observer.disconnect();
  }, [heat.weeks.length]);

  const priceOf = (model: string) => prices.models[model];
  const providerLabel = (id: string) => {
    const provider = s.settings.settings.providers.find((item) => item.id === id);
    return provider?.kind === "custom" ? provider.name : id;
  };
  const note = priceNote(prices);
  const maxModelCost = Math.max(0, ...modelRows.map((row) => row.cost ?? 0));
  const maxWhoCost = Math.max(0, ...whoRows.map((row) => row.cost));
  const yearSums = year.reduce((sum, day) => {
    const entry = perDay.get(day);
    return { requests: sum.requests + (entry?.requests ?? 0) };
  }, { requests: 0 });

  const openEditor = (model: string) => {
    const price = priceOf(model)?.price;
    setEditing(editing === model ? null : model);
    setEditError(null);
    setFields({
      input: price ? String(price.input) : "",
      output: price ? String(price.output) : "",
      cacheRead: price ? String(price.cacheRead) : "",
      cacheWrite: price ? String(price.cacheWrite) : "",
    });
  };

  const apply = (model: string, price: UsageModelPrice | null) => {
    setPrices((current) => {
      const models = { ...current.models };
      if (price) models[model] = price;
      else delete models[model];
      return { ...current, models };
    });
    setEditing(null);
    setEditError(null);
  };

  const save = async (model: string) => {
    if (busy) return;
    const price: TokenPrice = { input: Number(fields.input), output: Number(fields.output), cacheRead: Number(fields.cacheRead), cacheWrite: Number(fields.cacheWrite) };
    if (PRICE_FIELDS.some((field) => !Number.isFinite(price[field.key]) || price[field.key] < 0)) {
      setEditError("四项单价都要填大于等于 0 的数字（美元 / 百万 token）。");
      return;
    }
    setBusy(true);
    const result = await saveUsagePrice(model, price);
    setBusy(false);
    if (!result.ok) {
      setEditError(result.error);
      return;
    }
    apply(model, result.price);
  };

  const restore = async (model: string) => {
    if (busy) return;
    setBusy(true);
    const result = await saveUsagePrice(model, null);
    setBusy(false);
    if (!result.ok) {
      setEditError(result.error);
      return;
    }
    apply(model, result.price);
  };

  return (
    <>
      <PageHead title="消耗" desc="对话和任务用掉的 token 和花费，按服务商返回的用量统计；花费按模型价格估算，以服务商账单为准。" />

      <Group>
        <div className="u-seg">
          <Seg items={USAGE_RANGES.map(({ key, label }) => ({ key, label }))} value={range} onChange={setRange} />
        </div>
        <div className="group-card settings-card u-stats">
          <div className="u-stat">
            <span className="k">请求</span>
            <span className="v">{totals.requests.toLocaleString("en-US")}</span>
            {previous ? (
              previous.requests ? (
                <span className="s">
                  {range === "today" ? "比昨天" : `比上个 ${rangeDays} 天`} <b>{comparison(totals.requests, previous.requests)}</b>
                </span>
              ) : (
                <span className="s">{range === "today" ? "昨天" : "上个时段"}没有请求</span>
              )
            ) : null}
          </div>
          <div className="u-stat">
            <span className="k">输入 token</span>
            <span className="v">{usageCount(totals.input)}</span>
            {totals.input ? <span className="s">其中缓存命中 {usagePercent(totals.cacheRead / totals.input)}</span> : null}
          </div>
          <div className="u-stat">
            <span className="k">输出 token</span>
            <span className="v">{usageCount(totals.output)}</span>
            <span className="s">日均 {usageCount(totals.output / spanDays)}</span>
          </div>
          <div className="u-stat">
            <span className="k">花费</span>
            <span className="v">{usageMoney(totals.cost)}</span>
            <span className="s">日均 {usageMoney(totals.cost / spanDays)}</span>
          </div>
        </div>
        {note ? <div className="note">{note}</div> : null}
        {totals.unpriced ? <div className="note">有 {totals.unpriced} 个模型没有价格，这些模型的花费没有计入。</div> : null}
      </Group>

      <Group>
        <div className="lbl">最近一年 · 共 {usageCount(yearSums.requests)} 次请求</div>
        <div className="u-seg">
          <Seg items={USAGE_METRICS} value={metric} onChange={setMetric} />
        </div>
        <div className="u-heatwrap">
          <div className="group-card settings-card u-heat" onMouseLeave={() => setHover(null)} style={{ "--weeks": heat.weeks.length } as CSSProperties}>
            <div className="u-scroll" ref={heatScroll}>
              <div className="u-months">
                {heat.months.map((label, index) => <span key={index}>{label}</span>)}
              </div>
              <div className="u-grid">
                <div className="u-wd"><span>一</span><span /><span>三</span><span /><span>五</span><span /><span /></div>
                <div className="u-cells">
                  {heat.weeks.map((week, index) => (
                    <div className="hw" key={index}>
                      {week.map((day, at) => day ? (
                        <i
                          key={day}
                          className={`l${heat.level(day)}${day === today ? " today" : ""}`}
                          onMouseEnter={() => setHover(day)}
                          title={`${usageDayText(day)}：${perDay.get(day)?.requests ?? 0} 次请求 · ${usageCount((perDay.get(day)?.tokens ?? 0))} token · ${usageMoney(perDay.get(day)?.cost ?? 0)}`}
                        />
                      ) : <i key={`empty-${at}`} />)}
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="u-foot">
              <span>每格一天，{METRIC_TEXT[metric]}</span>
              <span className="u-legend">少 <i className="l0" /><i className="l1" /><i className="l2" /><i className="l3" /><i className="l4" /> 多</span>
            </div>
          </div>
          {hover ? (
            <div className="u-tip">
              <b>{usageDayText(hover)}</b>
              <br />
              {perDay.get(hover)?.requests ?? 0} 次请求 · {usageCount(perDay.get(hover)?.tokens ?? 0)} token · {usageMoney(perDay.get(hover)?.cost ?? 0)}
            </div>
          ) : null}
        </div>
      </Group>

      <Group>
        <div className="lbl">按模型 · {rangeLabel}</div>
        {modelRows.length ? (
          <div className="u-mhead">
            <span>模型</span>
            <span>花费占比</span>
            <span>请求</span>
            <span>输入</span>
            <span>输出</span>
            <span>缓存</span>
            <span>花费</span>
            <span>单价</span>
          </div>
        ) : null}
        <div className="group-card settings-card u-cards">
          {modelRows.length ? modelRows.map((row) => {
            const price = row.price;
            const share = maxModelCost > 0 && row.cost ? (row.cost / maxModelCost) * 100 : 0;
            return (
              <div key={row.model}>
                <div className="u-mrow">
                  <div className="u-mname">
                    <b title={row.model}>{row.model}</b>
                    <span>{providerLabel(row.provider)}{price?.custom ? <em>自定</em> : null}</span>
                  </div>
                  <div className="u-bar"><i style={{ width: `${share}%` }} /></div>
                  <div className="u-num u-req"><span className="u-k">请求</span>{row.requests.toLocaleString("en-US")}</div>
                  <div className="u-num u-in"><span className="u-k">输入</span>{usageCount(row.input)}</div>
                  <div className="u-num u-out"><span className="u-k">输出</span>{usageCount(row.output)}</div>
                  <div className="u-num u-cache"><span className="u-k">缓存命中</span>{row.input ? usagePercent(row.cacheRead / row.input) : "—"}</div>
                  <div className="u-num strong u-cost">{row.cost === null ? "—" : usageMoney(row.cost)}</div>
                  <button className={`u-price${price ? "" : " missing"}`} onClick={() => openEditor(row.model)} title="点这里改单价">
                    {price ? unitText(price.price) : "未定价"}
                  </button>
                </div>
                {editing === row.model ? (
                  <div className="u-edit">
                    <div className="u-edit-fields">
                      {PRICE_FIELDS.map((field) => (
                        <label key={field.key}>
                          <span>{field.label}</span>
                          <input
                            value={fields[field.key]}
                            inputMode="decimal"
                            disabled={busy}
                            onChange={(event) => setFields((current) => ({ ...current, [field.key]: event.target.value }))}
                          />
                        </label>
                      ))}
                    </div>
                    <div className="u-edit-actions">
                      <button className="hob-btn" onClick={() => void save(row.model)} disabled={busy}>保存</button>
                      <button className="hob-btn" onClick={() => setEditing(null)} disabled={busy}>取消</button>
                      {price?.custom ? <button className="hob-btn" onClick={() => void restore(row.model)} disabled={busy}>恢复默认</button> : null}
                      {editError ? <span className="badline">{editError}</span> : null}
                    </div>
                    <div className="note">美元 / 百万 token。缓存读是命中缓存的输入，缓存写是写进缓存的输入；花费按这里算，以服务商账单为准。</div>
                  </div>
                ) : null}
              </div>
            );
          }) : <Empty>这段时间没有用量</Empty>}
        </div>
        <div className="note">点单价可以改成自己的价格；改过的标「自定」，可以恢复默认。</div>
      </Group>

      <Group>
        <div className="lbl">按助手 · {rangeLabel}</div>
        <div className="group-card settings-card u-cards">
          {whoRows.length ? whoRows.map((row) => {
            const total = row.chat + row.job;
            const share = maxWhoCost > 0 ? (row.cost / maxWhoCost) * 100 : 0;
            return (
              <div className="u-wrow" key={row.id}>
                <b title={row.name}>{row.name}{row.archived ? "（已归档）" : ""}</b>
                <span>{total ? `对话 ${usagePercent(row.chat / total)} · 任务 ${usagePercent(row.job / total)}` : "对话 — · 任务 —"}</span>
                <div className="u-bar"><i style={{ width: `${share}%` }} /></div>
                <div className="u-num strong">{usageMoney(row.cost)}</div>
              </div>
            );
          }) : <Empty>这段时间没有用量</Empty>}
        </div>
      </Group>
    </>
  );
}

/** 多或少百分之几：正数带 +，负数带 −，一样多写「持平」。 */
function comparison(current: number, previous: number): string {
  const diff = (current - previous) / previous;
  if (Math.round(diff * 100) === 0) return "持平";
  return `${diff > 0 ? "+" : "−"}${Math.abs(Math.round(diff * 100))}%`;
}

/** 单价：输入 / 输出（美元 / 百万 token）。 */
function unitText(price: TokenPrice): string {
  return `${trimPrice(price.input)} / ${trimPrice(price.output)}`;
}

function trimPrice(value: number): string {
  return `$${Number(value.toFixed(2))}`;
}
