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
import { useAccounts, type MasteryTransferPreview } from "@/lib/queries.ts";
import { useMasteryTransferPreview, useMasteryMarketPreview } from "@/lib/mutations.ts";

const selectClass = "border-input bg-background h-9 w-full min-w-0 rounded-md border px-3 text-sm disabled:opacity-50";
const number = (value: number) => value.toLocaleString("zh-CN");

export default function MasteryTransferPreviewPage() {
  usePageHeader("专精鱼调配预览", "查看专精缺口、交换建议和市场限价购买预览");
  const accounts = useAccounts();
  const preview = useMasteryTransferPreview();
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const valid = !!sourceId && !!targetId && sourceId !== targetId;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (valid && !preview.isPending) preview.mutate({ sourceAccountId: sourceId, targetAccountId: targetId });
  }
  if (accounts.isPending) return <PageContainer><Skeleton className="h-64" /></PageContainer>;
  if (accounts.isError) return <PageContainer><Alert variant="destructive"><AlertDescription>{accounts.error.message}</AlertDescription></Alert></PageContainer>;
  if (accounts.data.length < 2) return <PageContainer>
    <EmptyState icon={<IconFish />} title="需要两个游戏账号" description="添加两个游戏账号后，可以查看专精鱼供需。"
      action={<Button asChild><Link to="/accounts">去账号页</Link></Button>} />
  </PageContainer>;

  return (
    <PageContainer>
      <div className="space-y-4">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2">专精鱼调配 <Badge variant="secondary">仅预览</Badge></CardTitle></CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={submit}>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="min-w-0 space-y-1.5">
                  <span className="text-sm font-medium">出鱼账号</span>
                  <select className={selectClass} value={sourceId} required disabled={preview.isPending}
                    onChange={(event) => { setSourceId(event.target.value); preview.reset(); }}>
                    <option value="">请选择出鱼账号</option>
                    {accounts.data.map((account) => <option key={account.id} value={account.id} disabled={account.id === targetId}>
                      {account.label}{account.player?.nickname ? `（${account.player.nickname}）` : ""}
                    </option>)}
                  </select>
                </label>
                <label className="min-w-0 space-y-1.5">
                  <span className="text-sm font-medium">收鱼账号</span>
                  <select className={selectClass} value={targetId} required disabled={preview.isPending}
                    onChange={(event) => { setTargetId(event.target.value); preview.reset(); }}>
                    <option value="">请选择收鱼账号</option>
                    {accounts.data.map((account) => <option key={account.id} value={account.id} disabled={account.id === sourceId}>
                      {account.label}{account.player?.nickname ? `（${account.player.nickname}）` : ""}
                    </option>)}
                  </select>
                </label>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <Button type="submit" disabled={!valid || preview.isPending}>
                  {preview.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconFish className="size-4" />}
                  {preview.isPending ? "正在读取供需…" : "生成供需预览"}
                </Button>
                <Button type="button" variant="outline" disabled={!valid || preview.isPending} onClick={() => {
                  setSourceId(targetId); setTargetId(sourceId); preview.reset();
                }}>对调方向</Button>
              </div>
              <p className="text-muted-foreground text-xs">只查看供需，不挂单、不解锁、不交换，也不自动献祭。</p>
            </form>
          </CardContent>
        </Card>
        {preview.isError ? <Alert variant="destructive"><IconAlertTriangle /><AlertDescription>{preview.error.message}</AlertDescription></Alert> : null}
        {preview.data ? <SupplyResult preview={preview.data} /> : null}
      </div>
    </PageContainer>
  );
}

function SupplyResult({ preview }: { preview: MasteryTransferPreview }) {
  const missing = preview.rows.reduce((sum, row) => sum + row.targetMissing, 0);
  const suggested = preview.rows.reduce((sum, row) => sum + row.suggestedQuantity, 0);
  return <div className="space-y-4" aria-live="polite">
    {preview.issues.length ? <Alert variant="destructive"><IconAlertTriangle /><AlertDescription>
      {preview.issues.map((issue) => <p key={issue}>{issue}</p>)}
    </AlertDescription></Alert> : null}
    <Card>
      <CardHeader><CardTitle className="break-words">{preview.source.nickname} → {preview.target.nickname}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">收鱼账号当前缺 <strong>{number(missing)}</strong> 条专精鱼，涉及 <strong>{preview.rows.length}</strong> 种；本次建议交换 <strong>{number(suggested)}</strong> 条。</p>
        <p className="text-muted-foreground text-xs">交换仅支持神话、奇异、奥秘鱼，同稀有度一条换一条，不收金币手续费。双方都先留足自己当前的专精需求；锁定和倍率保护的鱼不参与建议。</p>
        <p className="text-muted-foreground text-xs">数据读取于 {new Date(preview.createdAt).toLocaleString("zh-CN")}。本次没有预留库存；挂机、自动卖鱼或专精目标变化后，请重新读取。</p>
      </CardContent>
    </Card>
    {!preview.rows.length ? <EmptyState icon={<IconFish />} title="当前没有专精鱼缺口" description="收鱼账号当前已解锁且正在进行的专精目标，没有需要补充的鱼。" /> : null}
    {preview.rows.map((row) => <Card key={row.fishId}>
      <CardHeader><CardTitle className="flex flex-wrap items-center gap-2">
        {row.name}<Badge variant="secondary">{row.rarityLabel}</Badge><span className="text-muted-foreground text-xs font-normal">{row.biomeName}</span>
      </CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[
            { label: "收鱼账号还缺", value: row.targetMissing },
            { label: "出鱼账号库存", value: row.sourceOwned },
            { label: "为出鱼账号自身专精保留", value: row.sourceReserved },
            { label: "其中锁定或倍率保护", value: row.sourceProtected },
            { label: "最多可提供", value: row.sourceCanProvide },
            { label: "本次建议交换", value: row.suggestedQuantity },
          ].map(({ label, value }) => <div key={label}><dt className="text-muted-foreground text-xs">{label}</dt><dd className="mt-1 font-medium tabular-nums">{number(value)} 条</dd></div>)}
        </dl>
        {row.returnFish.length ? <div className="border-t pt-3">
          <p className="mb-2 font-medium">收鱼账号需要交回</p>
          <ul className="space-y-1">{row.returnFish.map((fish) => <li key={fish.fishId}>
            {fish.name} × {number(fish.quantity)}{fish.sourceNeedFilled > 0 ? <span className="text-muted-foreground ml-2 text-xs">其中 {number(fish.sourceNeedFilled)} 条可补出鱼账号的专精缺口</span> : null}
          </li>)}</ul>
        </div> : null}
        {row.notes.map((note) => <p key={note} className="text-muted-foreground text-xs">{note}</p>)}
        <MarketPurchasePreview key={`${preview.createdAt}:${preview.source.accountId}:${preview.target.accountId}`} preview={preview} fishId={row.fishId} />
      </CardContent>
    </Card>)}
  </div>;
}

function MarketPurchasePreview({ preview, fishId }: { preview: MasteryTransferPreview; fishId: string }) {
  const market = useMasteryMarketPreview();
  const [opened, setOpened] = useState(false);
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [budget, setBudget] = useState("");
  const [dirty, setDirty] = useState(false);
  const identity = { sourceAccountId: preview.source.accountId, targetAccountId: preview.target.accountId, fishId };
  function read(initial = false) {
    market.mutate(initial ? identity : { ...identity, quantity: Number(quantity), maxUnitPrice: Number(price), budget: Number(budget) }, {
      onSuccess: (result) => {
        setOpened(true); setDirty(false);
        setQuantity(String(result.requestedQuantity)); setPrice(String(result.maxUnitPrice)); setBudget(String(result.budget));
      },
    });
  }
  const result = market.data;
  return <div className="space-y-3 border-t pt-3">
    <p className="font-medium">市场补齐专精鱼</p>
    <p className="text-muted-foreground text-xs">由 {preview.target.nickname} 花金币买入。市场按价格匿名撮合，不能指定购买出鱼账号的鱼，也不保证金币转给该账号。</p>
    {!opened ? <Button type="button" variant="outline" size="sm" disabled={market.isPending} onClick={() => read(true)}>
      {market.isPending ? "正在读取市场…" : "查看限价购买预览"}
    </Button> : <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); read(); }}>
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { label: "想买数量", value: quantity, set: setQuantity, min: 1 },
          { label: "最高单价（金币）", value: price, set: setPrice, min: 1 },
          { label: "总预算（金币）", value: budget, set: setBudget, min: 0 },
        ].map((field) => <label key={field.label} className="space-y-1.5">
          <span className="text-xs">{field.label}</span>
          <Input type="number" min={field.min} max={Number.MAX_SAFE_INTEGER} step={1} required value={field.value} disabled={market.isPending}
            onChange={(event) => { field.set(event.target.value); setDirty(true); }} />
        </label>)}
      </div>
      <Button type="submit" variant="outline" size="sm" disabled={market.isPending}>{market.isPending ? "正在重新读取…" : "重新预览"}</Button>
    </form>}
    {market.isError ? <Alert variant="destructive"><AlertDescription>{market.error.message}</AlertDescription></Alert> : null}
    {dirty ? <p className="text-muted-foreground text-xs">输入已修改，请重新预览。</p> : result ? <div className="space-y-2" aria-live="polite">
      <p>当前专精缺 <strong>{number(result.targetMissing)}</strong> 条；市场最低单价 <strong>{number(result.minimumUnitPrice)}</strong> 金币，当前最低卖价 {result.bestAsk === null ? "暂无" : `${number(result.bestAsk)} 金币`}。</p>
      <p>按当前金币和预算，最多可委托 <strong>{number(result.orderQuantity)}</strong> 条，最多冻结 <strong>{number(result.reserveGold)}</strong> 金币。</p>
      <p>按已读取卖盘，预计立即买到 <strong>{number(result.expectedQuantity)}</strong> 条，花费 <strong>{number(result.expectedCostGold)}</strong> 金币；剩余 <strong>{number(result.pendingQuantity)}</strong> 条需等待卖单。</p>
      {result.fills.length ? <ul className="text-muted-foreground space-y-1 text-xs">{result.fills.map((fill) => <li key={fill.unitPrice}>
        {number(fill.unitPrice)} 金币 × {number(fill.quantity)} 条 = {number(fill.costGold)} 金币
      </li>)}</ul> : null}
      {result.issues.map((issue) => <p key={issue} className="text-xs">{issue}</p>)}
      <p className="text-muted-foreground text-xs">金币 {number(result.gold)}，单笔上限 {number(result.maxOrderQuantity)} 条。默认按市场最低单价预览，可自行调整。读取于 {new Date(result.createdAt).toLocaleString("zh-CN")}，最多读取 50 档卖盘；价格和库存会变化，预计成交不代表成交保证。</p>
    </div> : null}
    <p className="text-muted-foreground text-xs">仅预览，没有实际挂单、购买、冻结金币或献祭。</p>
  </div>;
}
