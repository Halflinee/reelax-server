import { useFishMarketDeals, type FishMarketDeal } from "@/lib/queries.ts";
import { useFishMarketDealAction } from "@/lib/mutations.ts";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog.tsx";

const number = (value: number) => value.toLocaleString("zh-CN");
const labels: Record<FishMarketDeal["status"], string> = { previewed: "等待确认买入", buying: "正在提交买单", buy_open: "买单等待成交", bought: "已买足，等待确认挂卖",
  selling: "正在提交卖单", sell_open: "卖单等待成交", completed: "两笔均已成交", failed: "买单未提交", review_required: "需要核对", closed: "已人工结束" };

export function FishMarketDeals() {
  const deals = useFishMarketDeals();
  const buy = useFishMarketDealAction("buy"); const sell = useFishMarketDealAction("sell");
  const check = useFishMarketDealAction("check"); const close = useFishMarketDealAction("close");
  const busy = buy.isPending || sell.isPending || check.isPending || close.isPending;
  const error = buy.error ?? sell.error ?? check.error ?? close.error ?? deals.error;
  return <Card><CardHeader><CardTitle>手动买卖记录</CardTitle></CardHeader><CardContent className="space-y-4">
    <p className="text-muted-foreground text-sm">先从扫描结果生成买入预览，再确认挂买单。买足后另行确认挂卖，价格和数量固定。刷新页面后记录仍在；“核对成交”只读订单，不会下单。同时售鱼或献祭可能影响可卖库存，挂卖前会重新核对。</p>
    {error ? <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert> : null}
    {deals.isPending ? <p className="text-muted-foreground text-sm">正在读取本地记录…</p> : !deals.data?.length ? <p className="text-muted-foreground text-sm">尚无记录。下方有预期利润的鱼种可点击“生成买入预览”。</p> : null}
    {deals.data?.map((deal) => {
      const { plan } = deal; const executing = deal.status === "buying" || deal.status === "selling";
      const canCheck = ["buy_open", "bought", "sell_open", "review_required"].includes(deal.status);
      return <section key={deal.id} className="space-y-3 rounded-md border p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2"><strong>{plan.account.label} · {plan.fish.name} × {number(plan.quantity)}</strong><Badge variant="secondary">{labels[deal.status]}</Badge></div>
        <p>买入限价 {number(plan.buyPrice)} → 卖出限价 {number(plan.sellPrice)} 金币；买单最多冻结 {number(plan.maxCostGold)} 金币。</p>
        <p>原预览税率 {number(plan.feeBasisPoints / 100)}%，估算税费 {number(plan.expectedFeeGold)}，预期净利润 {number(plan.expectedProfitGold)} 金币。</p>
        <p>已买 {number(deal.boughtQuantity)} / {number(plan.quantity)}，实际支出 {number(deal.costGold)}；已卖 {number(deal.soldQuantity)} / {number(plan.quantity)}，实际卖出 {number(deal.grossGold)}，实际税费 {number(deal.feeGold)} 金币。</p>
        {deal.status === "completed" && deal.profitGold !== null ? <p>本笔实际净利润：<strong className={deal.profitGold > 0 ? "text-emerald-600" : "text-destructive"}>{number(deal.profitGold)} 金币</strong></p> : <p className="text-muted-foreground text-xs">尚未核对两笔完整成交，不能将预期利润当作已实现。</p>}
        <p role="status">{deal.message}</p>
        <div className="flex flex-wrap gap-2">
          {deal.status === "previewed" ? <ConfirmAction label="确认买入" title="确认挂限价买单" disabled={busy || deal.expiresAt <= Date.now()} onConfirm={() => buy.mutate(deal.id)}>
            {plan.account.label}（{plan.account.nickname}）将以每条最多 {number(plan.buyPrice)} 金币买入 {plan.fish.name} {number(plan.quantity)} 条，最多冻结 {number(plan.maxCostGold)} 金币。低价买单可能长期等待或部分成交。这一步只挂买单，买足后仍需你另行确认按 {number(plan.sellPrice)} 金币挂卖；不保证能盈利。确认即接受公开市场成交及后续行情变化风险。
          </ConfirmAction> : null}
          {deal.status === "bought" ? <ConfirmAction label="按预览价挂卖" title="确认按已保存价格挂卖" disabled={busy} onConfirm={() => sell.mutate(deal.id)}>
            {plan.account.label} 将以每条至少 {number(plan.sellPrice)} 金币挂卖 {plan.fish.name} {number(plan.quantity)} 条，本次实际买入支出 {number(deal.costGold)} 金币。会重新核对订单、库存、锁定保护和税率，不会自动改价或减少数量。卖单可能长期等待；确认即接受公开市场成交风险。
          </ConfirmAction> : null}
          {canCheck ? <Button type="button" variant="outline" disabled={busy || executing} onClick={() => check.mutate(deal.id)}>核对成交（不下单）</Button> : null}
          {canCheck ? <ConfirmAction label="已在游戏内处理，结束记录" title="确认已经人工核对并处理" disabled={busy} onConfirm={() => close.mutate(deal.id)}>
            请先在游戏内核对本次买卖订单，取消不再需要的剩余订单并处理鱼获。只有你确认已处理后才结束记录、解除账号交易占用。结束记录不会替你撤单、退款、卖鱼或核算未完成的利润。
          </ConfirmAction> : null}
        </div>
        {deal.status === "previewed" ? <p className="text-muted-foreground text-xs">买入预览有效至 {new Date(deal.expiresAt).toLocaleString("zh-CN")}，过期请重新生成。</p> : null}
        <p className="text-muted-foreground break-all text-xs">买单：{deal.buyOrderId ?? "尚无确定编号"}；卖单：{deal.sellOrderId ?? "尚无确定编号"}；记录更新于 {new Date(deal.updatedAt).toLocaleString("zh-CN")}</p>
      </section>;
    })}
  </CardContent></Card>;
}

function ConfirmAction({ label, title, disabled, onConfirm, children }: { label: string; title: string; disabled: boolean; onConfirm: () => void; children: React.ReactNode }) {
  return <AlertDialog><AlertDialogTrigger asChild><Button type="button" variant="outline" disabled={disabled}>{label}</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle><AlertDialogDescription>{children}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>返回</AlertDialogCancel><AlertDialogAction disabled={disabled} onClick={onConfirm}>确认</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>;
}
