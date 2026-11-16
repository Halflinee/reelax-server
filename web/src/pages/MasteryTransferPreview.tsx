import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { IconAlertTriangle, IconFish, IconLoader2 } from "@tabler/icons-react";
import { PageContainer, EmptyState } from "@/components/layout/PageContainer.tsx";
import { usePageHeader } from "@/components/layout/page-header.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Input } from "@/components/ui/input.tsx";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog.tsx";
import { useAccounts, useMasteryDemandOptions, useFishTransfer, useFishTransferHistory, type FishTradeQuote, type FishTransfer } from "@/lib/queries.ts";
import { useMasterySupplyPreview, useFishTradeQuote, useFishTransferAction, useRefreshMasteryCatalog } from "@/lib/mutations.ts";

const selectClass = "border-input bg-background h-9 w-full min-w-0 rounded-md border px-3 text-sm disabled:opacity-50";
const number = (value: number) => value.toLocaleString("zh-CN");
const count = (value: number | null) => value === null ? "—" : number(value);
const positive = (value: string) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;

export default function MasteryTransferPreviewPage() {
  usePageHeader("专精鱼金币调配", "选择需求账号和专精鱼，查看全部供给账号，再手动确认市场交易");
  const accounts = useAccounts();
  const [targetId, setTargetId] = useState("");
  const [biomeId, setBiomeId] = useState("");
  const [fishId, setFishId] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [operationId, setOperationId] = useState<string | null>(null);
  const demand = useMasteryDemandOptions(targetId);
  const supply = useMasterySupplyPreview();
  const refreshCatalog = useRefreshMasteryCatalog();
  const quote = useFishTradeQuote();
  const confirm = useFishTransferAction("confirm");
  const operation = useFishTransfer(operationId);
  const history = useFishTransferHistory();
  const busy = !!(confirm.isPending || operation.data?.status === "executing" || history.data?.some((item) => item.status === "executing"));
  const reading = supply.isPending || quote.isPending || refreshCatalog.isPending;
  const biome = demand.data?.biomes.find((entry) => entry.id === biomeId);
  const selectedFish = biome?.fish.find((entry) => entry.id === fishId);
  const selectedSource = supply.data?.suppliers.find((entry) => entry.accountId === sourceId);
  function clearQuote() { quote.reset(); confirm.reset(); setOperationId(null); }
  function clearSupply() { supply.reset(); clearQuote(); setSourceId(""); }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!targetId || !biomeId || !fishId || busy || reading) return;
    clearQuote(); setSourceId("");
    supply.mutate({ targetAccountId: targetId, biomeId, fishId }, { onSuccess: (data) => {
      setPrice(String(data.market?.minimumUnitPrice ?? data.fish.sellPrice));
      setQuantity(String(Math.min(data.targetMissing, data.market?.maxOrderQuantity ?? data.targetMissing)));
    } });
  }
  if (accounts.isPending) return <PageContainer><Skeleton className="h-64" /></PageContainer>;
  if (accounts.isError) return <PageContainer><Alert variant="destructive"><AlertDescription>{accounts.error.message}</AlertDescription></Alert></PageContainer>;
  if (accounts.data.length < 2) return <PageContainer><EmptyState icon={<IconFish />} title="需要两个游戏账号" description="添加需求账号和至少一个供给账号后使用。" action={<Button asChild><Link to="/accounts">去账号页</Link></Button>} /></PageContainer>;

  return <PageContainer><div className="space-y-4">
    <Card><CardHeader><CardTitle className="flex items-center gap-2">选择需求 <Badge variant="secondary">预览后手动确认</Badge></CardTitle></CardHeader><CardContent>
      <form className="space-y-4" onSubmit={submit}><fieldset className="space-y-4" disabled={busy || reading}>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="space-y-1.5"><span className="text-sm font-medium">需求账号</span>
            <select className={selectClass} required value={targetId} onChange={(event) => { setTargetId(event.target.value); setBiomeId(""); setFishId(""); clearSupply(); refreshCatalog.reset(); }}>
              <option value="">请选择需求账号</option>{accounts.data.map((account) => <option key={account.id} value={account.id}>{account.label}{account.player?.nickname ? `（${account.player.nickname}）` : ""}</option>)}
            </select>
          </label>
          <label className="space-y-1.5"><span className="text-sm font-medium">地图区域</span>
            <select className={selectClass} required value={biomeId} disabled={!demand.data || demand.isFetching} onChange={(event) => { setBiomeId(event.target.value); setFishId(""); clearSupply(); }}>
              <option value="">{demand.isFetching ? "正在读取专精目标…" : "请选择地图区域"}</option>{demand.data?.biomes.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </select>
          </label>
          <label className="space-y-1.5"><span className="text-sm font-medium">专精鱼</span>
            <select className={selectClass} required value={fishId} disabled={!biome || demand.isFetching} onChange={(event) => { setFishId(event.target.value); clearSupply(); }}>
              <option value="">请选择专精鱼</option>{biome?.fish.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.rarityLabel} · 缺 {number(entry.missing)} 条</option>)}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={!selectedFish || demand.isFetching || reading || busy}>{supply.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconFish className="size-4" />}{supply.isPending ? "正在读取全部账号…" : "生成供需预览"}</Button>
        <Button type="button" variant="outline" disabled={!targetId || demand.isFetching || reading || busy} onClick={() => {
          clearSupply(); setBiomeId(""); setFishId(""); refreshCatalog.mutate(targetId);
        }}>{refreshCatalog.isPending ? "正在更新固定资料…" : "更新固定资料"}</Button>
        </div>
        <p className="text-muted-foreground text-xs">固定地图、鱼种资料首次下载后保存在服务器，重启也能使用。专精需求、库存及交易数据实时读取；游戏新增内容后再点「更新固定资料」。供需预览不会挂单或扣金币。</p>
      </fieldset></form>
      {demand.isError ? <p role="alert" className="text-destructive mt-3 text-sm">{demand.error.message}</p> : null}
      {refreshCatalog.isError ? <p role="alert" className="text-destructive mt-3 text-sm">{refreshCatalog.error.message}</p> : null}
      {demand.data && !demand.data.biomes.length ? <p className="text-muted-foreground mt-3 text-sm">这个账号当前没有正在进行的专精目标。</p> : null}
    </CardContent></Card>
    {supply.isError ? <Alert variant="destructive"><AlertDescription>{supply.error.message}</AlertDescription></Alert> : null}
    {supply.data ? <Card><CardHeader><CardTitle>{supply.data.fish.biomeName} · {supply.data.fish.name} <Badge variant="secondary">{supply.data.fish.rarityLabel}</Badge></CardTitle></CardHeader><CardContent className="space-y-4">
      <p className="text-sm">需求账号 {supply.data.target.label}（{supply.data.target.nickname}）当前缺 <strong>{number(supply.data.targetMissing)}</strong> 条，金币 <strong>{number(supply.data.target.gold)}</strong>。</p>
      <fieldset className="space-y-3" disabled={busy || reading}><legend className="mb-3 text-sm font-medium">其他账号的指定鱼库存 · 选择一个供给方</legend>
        {supply.data.suppliers.map((source) => <label key={source.accountId} className={`block rounded-md border p-3 ${sourceId === source.accountId ? "border-primary" : "border-border"}`}>
          <div className="flex items-start gap-3"><input type="radio" name="fish-supplier" value={source.accountId} checked={sourceId === source.accountId}
            disabled={!!source.issue || !source.canProvide || !supply.data!.market || !supply.data!.targetMissing}
            onChange={() => { setSourceId(source.accountId); clearQuote(); setQuantity(String(Math.min(source.canProvide!, supply.data!.targetMissing, supply.data!.market!.maxOrderQuantity))); }} className="mt-1" />
            <div className="min-w-0 flex-1 space-y-2"><p className="break-words text-sm font-medium">{source.label}{source.nickname ? `（${source.nickname}）` : ""}</p>
              <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">{[{ label: "库存", value: source.owned }, { label: "自身专精保留", value: source.reserved }, { label: "锁定或倍率保护", value: source.protected }, { label: "可供数量", value: source.canProvide }].map((item) => <div key={item.label}><dt className="text-muted-foreground">{item.label}</dt><dd className="mt-1 tabular-nums">{count(item.value)}</dd></div>)}</dl>
              {source.issue ? <p className="text-destructive text-xs">{source.issue}</p> : null}
            </div>
          </div>
        </label>)}
        {!supply.data.suppliers.length ? <p className="text-muted-foreground text-sm">当前没有其他供给账号。</p> : null}
      </fieldset>
      {!supply.data.market ? <p className="text-destructive text-sm">需求账号尚不能使用市场。</p> : <p className="text-muted-foreground text-xs">最低单价 {number(supply.data.market.minimumUnitPrice)} 金币，单笔最多 {number(supply.data.market.maxOrderQuantity)} 条。可供数量已保留供给方自身当前专精所需，并排除锁定和倍率保护；重叠部分不重复扣除。</p>}
      <p className="text-muted-foreground text-xs">读取于 {new Date(supply.data.createdAt).toLocaleString("zh-CN")}。未预留鱼或金币，确认前会再次检查。</p>
      {selectedSource ? <form className="space-y-3 border-t pt-4" onSubmit={(event) => {
        event.preventDefault();
        if (busy || reading || !positive(quantity) || !positive(price)) return;
        clearQuote(); quote.mutate({ targetAccountId: targetId, sourceAccountId: sourceId, biomeId, fishId, quantity: Number(quantity), unitPrice: Number(price) }, {
          onSuccess: (result) => { setOperationId(result.confirmation?.id ?? null); },
        });
      }}><fieldset disabled={busy || reading} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5"><span className="text-sm">交易单价（金币）</span><Input type="number" required min={1} max={Number.MAX_SAFE_INTEGER} step={1} value={price} onChange={(event) => { setPrice(event.target.value); clearQuote(); }} /></label>
          <label className="space-y-1.5"><span className="text-sm">交易数量（条）</span><Input type="number" required min={1} max={Number.MAX_SAFE_INTEGER} step={1} value={quantity} onChange={(event) => { setQuantity(event.target.value); clearQuote(); }} /></label>
        </div>
        <Button type="submit" variant="outline" disabled={!positive(quantity) || !positive(price) || busy || reading}>{quote.isPending ? "正在检查交易条件…" : "预览这笔交易"}</Button>
      </fieldset></form> : null}
    </CardContent></Card> : null}
    {quote.isError ? <Alert variant="destructive"><AlertDescription>{quote.error.message}</AlertDescription></Alert> : null}
    {quote.data ? <QuoteResult quote={quote.data} disabled={busy || reading || !operation.data || operation.data.status !== "previewed" || operation.data.expiresAt <= Date.now()} onConfirm={() => confirm.mutate(quote.data!.confirmation!.id)} /> : null}
    {confirm.isError ? <Alert variant="destructive"><AlertDescription>{confirm.error.message}</AlertDescription></Alert> : null}
    {operation.isError ? <Alert variant="destructive"><AlertDescription>读取交易状态失败，请先刷新核对：{operation.error.message}</AlertDescription></Alert> : null}
    {operation.data && operation.data.status !== "previewed" ? <FishStatus operation={operation.data} /> : null}
    {history.isError ? <Alert variant="destructive"><AlertDescription>读取交易记录失败：{history.error.message}</AlertDescription></Alert> : null}
    {history.data?.filter((item) => item.id !== operationId).map((item) => <FishStatus key={item.id} operation={item} />)}
  </div></PageContainer>;
}

function QuoteResult({ quote, disabled, onConfirm }: { quote: FishTradeQuote; disabled: boolean; onConfirm: () => void }) {
  return <Card><CardHeader><CardTitle>交易预览</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
    <p>{quote.target.label}（{quote.target.nickname}）挂买单 → {quote.source.label}（{quote.source.nickname}）按价卖出。</p>
    <p>{quote.fish.biomeName} · {quote.fish.name} × {number(quote.quantity)} 条，单价 {number(quote.unitPrice)} 金币。</p>
    <p>需求方最多支付 <strong>{number(quote.grossGold)}</strong> 金币；供给方预计实收 <strong>{number(quote.netGold)}</strong> 金币，预计手续费 {number(quote.feeGold)} 金币。实际按成交记录结算。</p>
    <Alert><IconAlertTriangle /><AlertDescription>这是公开市场撮合，价格和数量不能指定交易对象。即使检查通过，也可能买到或卖给其他玩家。发现竞争订单或结果不明会停止；已挂出的剩余订单需到游戏内核对并取消。</AlertDescription></Alert>
    {quote.issues.map((issue) => <p key={issue} className="text-destructive">{issue}</p>)}
    {quote.confirmation ? <AlertDialog><AlertDialogTrigger asChild><Button disabled={disabled}>确认交易</Button></AlertDialogTrigger><AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>确认公开市场实际交易</AlertDialogTitle><AlertDialogDescription>
        需求账号 {quote.target.label}（{quote.target.nickname}）先挂买单，供给账号 {quote.source.label}（{quote.source.nickname}）再卖出 {quote.fish.name} {number(quote.quantity)} 条，单价 {number(quote.unitPrice)} 金币，总计 {number(quote.grossGold)} 金币。
        确认后会真实冻结金币、挂单和卖鱼。无法锁定交易对象，可能被其他玩家成交；未完成的订单可能继续冻结鱼或金币，需要到游戏内核对并取消。本次确认有效至 {new Date(quote.confirmation.expiresAt).toLocaleTimeString("zh-CN")}。
      </AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>返回检查</AlertDialogCancel><AlertDialogAction disabled={disabled} onClick={onConfirm}>接受公开撮合并交易</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog> : null}
  </CardContent></Card>;
}

const statusLabel: Record<FishTransfer["status"], string> = { previewed: "待确认", executing: "进行中", completed: "已完成", failed: "尚未挂单", review_required: "需要核对", closed: "已手动结束" };
function FishStatus({ operation }: { operation: FishTransfer }) {
  const check = useFishTransferAction("check");
  const close = useFishTransferAction("close");
  const busy = check.isPending || close.isPending;
  return <Card><CardHeader><CardTitle>{statusLabel[operation.status]} · {operation.quote.fish.name}</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
    <p>{operation.quote.target.label}（需求）← {operation.quote.source.label}（供给） · {number(operation.quote.quantity)} 条 × {number(operation.quote.unitPrice)} 金币</p>
    <p>{operation.message}</p>
    {operation.buyerOrderId ? <p className="text-muted-foreground break-all text-xs">需求方买单：{operation.buyerOrderId}</p> : null}
    {operation.sellerOrderId ? <p className="text-muted-foreground break-all text-xs">供给方卖单：{operation.sellerOrderId}</p> : null}
    {operation.settlement ? <p>已核对 {number(operation.settlement.quantity)} 条，实际支付 {number(operation.settlement.grossGold)} 金币，手续费 {number(operation.settlement.feeGold)} 金币，供给方实收 {number(operation.settlement.netGold)} 金币。</p> : null}
    {operation.status === "review_required" ? <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={busy} onClick={() => check.mutate(operation.id)}>{check.isPending ? "正在核对…" : "核对成交结果"}</Button>
      <AlertDialog><AlertDialogTrigger asChild><Button variant="outline" disabled={busy}>已在游戏内核对，结束记录</Button></AlertDialogTrigger><AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>确认已核对并处理剩余挂单</AlertDialogTitle><AlertDialogDescription>请先到游戏内检查需求方和供给方的成交记录，并取消仍未成交的本次订单。结束记录不会撤单、退款或再次交易，只解除后续交易限制。</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>返回核对</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={() => close.mutate(operation.id)}>我已核对，结束记录</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent></AlertDialog>
    </div> : null}
    {check.isError || close.isError ? <p role="alert" className="text-destructive">{check.error?.message ?? close.error?.message}</p> : null}
  </CardContent></Card>;
}
