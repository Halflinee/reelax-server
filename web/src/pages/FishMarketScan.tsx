import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { IconChartDots, IconLoader2 } from "@tabler/icons-react";
import { PageContainer, EmptyState } from "@/components/layout/PageContainer.tsx";
import { usePageHeader } from "@/components/layout/page-header.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { FishMarketDeals } from "@/components/domain/FishMarketDeals.tsx";
import { useAccounts, useFishMarketOptions, type FishMarketRow, type MarketProfit } from "@/lib/queries.ts";
import { useFishMarketScan, useRefreshMasteryCatalog, usePrepareFishMarketDeal } from "@/lib/mutations.ts";

const selectClass = "border-input bg-background h-9 w-full min-w-0 rounded-md border px-3 text-sm disabled:opacity-50";
const number = (value: number) => value.toLocaleString("zh-CN");
const integer = (value: string, min: number) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= min;
const opportunity = (row: FishMarketRow) => !row.error && row.waitingWithinLimits && (row.waiting?.profitGold ?? 0) > 0;

export default function FishMarketScanPage() {
  usePageHeader("市场行情与手动买卖", "扫描税后利润，买入与挂卖分两步手动确认");
  const accounts = useAccounts(); const scan = useFishMarketScan(); const refresh = useRefreshMasteryCatalog();
  const prepare = usePrepareFishMarketDeal(); const dealsSection = useRef<HTMLDivElement>(null);
  const [accountId, setAccountId] = useState(""); const [biomeId, setBiomeId] = useState(""); const [fishId, setFishId] = useState("");
  const [quantity, setQuantity] = useState("1"); const [minimumProfit, setMinimumProfit] = useState("1"); const [onlyProfit, setOnlyProfit] = useState(false);
  const [rows, setRows] = useState<FishMarketRow[]>([]); const [total, setTotal] = useState(0); const [running, setRunning] = useState(false);
  const [stopped, setStopped] = useState(false); const [error, setError] = useState("");
  const [snapshot, setSnapshot] = useState<{ gold: number; rate: number; label: string; quantity: number } | null>(null);
  const stop = useRef(false); const mounted = useRef(true); const active = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stop.current = true; }; }, []);
  const options = useFishMarketOptions(accountId);
  const fish = options.data?.fish.filter((entry) => entry.biomeId === biomeId) ?? [];
  const selected = fishId ? fish.filter((entry) => entry.id === fishId) : fish;
  const busy = running || refresh.isPending || prepare.isPending;
  function previewBuy(row: FishMarketRow) {
    const result = row.waiting;
    if (busy || !result || result.buyPrice === null || result.sellPrice === null || !snapshot) return;
    prepare.mutate({ accountId, fishId: row.fish.id, quantity: result.quantity, buyPrice: result.buyPrice, sellPrice: result.sellPrice }, {
      onSuccess: () => dealsSection.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
    });
  }
  function clear() { setRows([]); setTotal(0); setSnapshot(null); setError(""); setStopped(false); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (active.current || busy || !selected.length || !integer(quantity, 1)) return;
    active.current = true; stop.current = false; clear(); setRunning(true); setTotal(selected.length);
    const requested = Number(quantity); const label = accounts.data?.find((entry) => entry.id === accountId)?.label ?? "";
    try {
      // 每批最多三种鱼，上一批完成后立即展示；停止只阻止后续批次。
      for (let index = 0; index < selected.length && !stop.current; index += 3) {
        const result = await scan.mutateAsync({ accountId, fishIds: selected.slice(index, index + 3).map((entry) => entry.id), quantity: requested });
        if (!mounted.current) return;
        setRows((previous) => [...previous, ...result.rows]);
        setSnapshot({ gold: result.gold, rate: result.feeBasisPoints, label, quantity: requested });
      }
      if (mounted.current) setStopped(stop.current);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "扫描失败"); }
    finally { active.current = false; if (mounted.current) setRunning(false); }
  }
  if (accounts.isPending) return <PageContainer><Skeleton className="h-64" /></PageContainer>;
  if (accounts.isError) return <PageContainer><Alert variant="destructive"><AlertDescription>{accounts.error.message}</AlertDescription></Alert></PageContainer>;
  if (!accounts.data.length) return <PageContainer><EmptyState icon={<IconChartDots />} title="先添加游戏账号" description="选择一个能使用市场的账号读取行情。" action={<Button asChild><Link to="/accounts">去账号页</Link></Button>} /></PageContainer>;
  const validProfit = integer(minimumProfit, 1);
  const visible = [...rows].filter((row) => !onlyProfit || (validProfit && opportunity(row) && row.waiting!.profitGold >= Number(minimumProfit)))
    .sort((a, b) => Number(opportunity(b)) - Number(opportunity(a)) || (b.waiting?.profitGold ?? -Infinity) - (a.waiting?.profitGold ?? -Infinity) || a.fish.name.localeCompare(b.fish.name, "zh-CN"));
  return <PageContainer><div className="space-y-4">
    <Card><CardHeader><CardTitle className="flex items-center gap-2">扫描范围 <Badge variant="secondary">只读，不下单</Badge></CardTitle></CardHeader><CardContent>
      <form onSubmit={(event) => { void submit(event); }} className="space-y-4"><fieldset disabled={busy} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="space-y-1.5"><span className="text-sm">行情账号</span><select className={selectClass} required value={accountId} onChange={(event) => { setAccountId(event.target.value); setBiomeId(""); setFishId(""); clear(); refresh.reset(); }}>
            <option value="">请选择账号</option>{accounts.data.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select></label>
          <label className="space-y-1.5"><span className="text-sm">地图区域</span><select className={selectClass} required value={biomeId} disabled={!options.data || options.isFetching} onChange={(event) => { setBiomeId(event.target.value); setFishId(""); clear(); }}>
            <option value="">{options.isFetching ? "正在读取鱼种资料…" : "请选择地图"}</option>{options.data?.biomes.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select></label>
          <label className="space-y-1.5"><span className="text-sm">鱼种</span><select className={selectClass} value={fishId} disabled={!biomeId || options.isFetching} onChange={(event) => { setFishId(event.target.value); clear(); }}>
            <option value="">本地图全部鱼种（{fish.length} 种）</option>{fish.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.rarityLabel}</option>)}
          </select></label>
          <label className="space-y-1.5"><span className="text-sm">每种鱼试算数量</span><Input required type="number" min={1} max={Number.MAX_SAFE_INTEGER} step={1} value={quantity} onChange={(event) => { setQuantity(event.target.value); clear(); }} /></label>
        </div>
        <div className="flex flex-wrap gap-3"><Button type="submit" disabled={!selected.length || !integer(quantity, 1) || options.isFetching}>{running ? <IconLoader2 className="size-4 animate-spin" /> : <IconChartDots className="size-4" />}开始扫描</Button>
          <Button type="button" variant="outline" disabled={!accountId || options.isFetching} onClick={() => { clear(); setBiomeId(""); setFishId(""); refresh.mutate(accountId); }}>{refresh.isPending ? "正在更新…" : "更新固定资料"}</Button></div>
      </fieldset></form>
      {running ? <Button className="mt-3" type="button" variant="outline" onClick={() => { stop.current = true; setStopped(true); }} disabled={stopped}>{stopped ? "当前批次完成后停止" : "停止后续扫描"}</Button> : null}
      <p className="text-muted-foreground mt-3 text-xs">地图和鱼种使用本地资料；每批最多读取三种鱼，结果逐批显示。扫描按需手动启动，不会后台持续请求。</p>
      {options.isError || refresh.isError ? <p role="alert" className="text-destructive mt-3 text-sm">{options.error?.message ?? refresh.error?.message}</p> : null}
    </CardContent></Card>
    <Alert><AlertDescription>现价买入要付最低卖价，现价卖出只能收最高买价，通常不能马上获利。挂单试算则是假设先低价买到、再高价卖出，等待时间和成交都不保证。匿名盘口可能包含自己的挂单，不能把报价当成已实现利润。</AlertDescription></Alert>
    {total ? <Card><CardContent className="space-y-3 pt-5">
      <p aria-live="polite">{running ? "正在扫描" : error ? "扫描中断" : stopped ? "已停止" : "扫描完成"}：已读取 {rows.length} / {total} 种；读取失败 {rows.filter((row) => row.error).length} 种。</p>
      {snapshot ? <p className="text-sm">{snapshot.label} · 最近读取余额 {number(snapshot.gold)} 金币 · 税率 {number(snapshot.rate / 100)}% · 每种试算 {number(snapshot.quantity)} 条。每行行情读取时间可能不同，本金按每种单独计算，不能相加当作同时可买数量。</p> : null}
      <div className="flex flex-wrap items-center gap-3 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={onlyProfit} onChange={(event) => setOnlyProfit(event.target.checked)} />只看有预期利润且本金、额度允许的鱼种</label>
        <label className="flex items-center gap-2">最低净利润<Input className="w-28" type="number" min={1} max={Number.MAX_SAFE_INTEGER} step={1} value={minimumProfit} onChange={(event) => setMinimumProfit(event.target.value)} /></label></div>
      {!validProfit ? <p className="text-destructive text-sm">最低净利润请输入正整数。</p> : null}
      <p className="text-muted-foreground text-xs">税费按每条鱼向上取整作保守估算，净利润 = 卖出金额 − 估算税费 − 买入成本。最终按真实分笔成交结算；扫描不会下单，需另行确认买入和挂卖。</p>
    </CardContent></Card> : null}
    {error ? <Alert variant="destructive"><AlertDescription>{error}。已读取的结果仍保留；未读取部分不代表没有机会。</AlertDescription></Alert> : null}
    {prepare.isError ? <Alert variant="destructive"><AlertDescription>{prepare.error.message}</AlertDescription></Alert> : null}
    <div ref={dealsSection}><FishMarketDeals /></div>
    {visible.map((row) => <MarketRow key={row.fish.id} row={row} disabled={busy} onPreview={() => previewBuy(row)} />)}
    {rows.length > 0 && !visible.length ? <p className="text-muted-foreground text-sm">已读取的鱼种没有符合当前筛选条件的结果。取消筛选可查看亏损、缺少报价和读取失败的鱼种。</p> : null}
  </div></PageContainer>;
}

function ProfitView({ title, result }: { title: string; result: MarketProfit | null }) {
  return <div className="space-y-1 rounded-md border p-3 text-sm"><p className="font-medium">{title}</p>{result ? <>
    {result.buyPrice !== null ? <p>买入单价 {number(result.buyPrice)} → 卖出单价 {number(result.sellPrice!)} 金币</p> : <p>按可见买卖盘逐档计算，共 {number(result.quantity)} 条</p>}
    <p>本金 {number(result.costGold)} · 卖出 {number(result.grossGold)} · 估算税费 {number(result.feeGold)}</p>
    <p>税后收入 {number(result.netGold)} · 净利润 <strong className={result.profitGold > 0 ? "text-emerald-600" : "text-destructive"}>{number(result.profitGold)}</strong> 金币（{number(result.returnPercent)}%）</p>
    <p className="text-muted-foreground text-xs">按同样数量卖出，保本单价至少 {result.breakEvenPrice === null ? "无法计算（税率或金额限制）" : `${number(result.breakEvenPrice)} 金币`}。</p>
  </> : <p className="text-muted-foreground">当前条件不足，无法试算。</p>}</div>;
}
function MarketRow({ row, disabled, onPreview }: { row: FishMarketRow; disabled: boolean; onPreview: () => void }) {
  return <Card><CardHeader><CardTitle className="flex flex-wrap items-center gap-2">{row.fish.name}<Badge variant="secondary">{row.fish.biomeName} · {row.fish.rarityLabel}</Badge>{opportunity(row) ? <Badge>挂单后有预期利润</Badge> : null}</CardTitle>
    <p className="text-muted-foreground text-xs">读取于 {new Date(row.readAt).toLocaleString("zh-CN")} · 税率 {row.feeBasisPoints === null ? "未知" : `${number(row.feeBasisPoints / 100)}%`}</p></CardHeader><CardContent className="space-y-3">
    {row.error ? <p role="alert" className="text-destructive text-sm">读取失败：{row.error}，本行收益未知。</p> : <>
      <p className="text-sm">最高买价 {row.buyLevels[0] ? number(row.buyLevels[0].unitPrice) : "暂无买单"} · 最低卖价 {row.sellLevels[0] ? number(row.sellLevels[0].unitPrice) : "暂无卖单"} · 市场底价 {number(row.minimumPrice!)}</p>
      <div className="grid gap-3 lg:grid-cols-2"><ProfitView title="按现价立即买入再卖出（快照试算）" result={row.immediate} /><ProfitView title="挂单等待：低买高卖（未成交预测）" result={row.waiting} /></div>
      {row.notes.map((note) => <p key={note} className="text-muted-foreground text-sm">{note}</p>)}
      {opportunity(row) ? <Button type="button" disabled={disabled} onClick={onPreview}>生成买入预览（不下单）</Button> : null}
      <details className="text-sm"><summary className="cursor-pointer">查看买卖盘口（各最多 50 个价格档位）</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">
        <BookLevels title="市场买单" levels={row.buyLevels} /><BookLevels title="市场卖单" levels={row.sellLevels} />
      </div></details>
    </>}
  </CardContent></Card>;
}

function BookLevels({ title, levels }: { title: string; levels: FishMarketRow["buyLevels"] }) {
  return <div className="max-h-64 overflow-auto rounded-md border p-3"><p className="mb-2 font-medium">{title}</p><table className="w-full text-left"><thead><tr><th scope="col">单价（金币）</th><th scope="col">数量（条）</th></tr></thead><tbody>{levels.map((level, index) => <tr key={index}><td>{number(level.unitPrice)}</td><td>{number(level.quantity)}</td></tr>)}</tbody></table>{!levels.length ? <p>暂无订单</p> : null}</div>;
}
