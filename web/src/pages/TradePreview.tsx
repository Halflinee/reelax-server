import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { IconAlertTriangle, IconCoins, IconLoader2 } from "@tabler/icons-react";
import { PageContainer, EmptyState } from "@/components/layout/PageContainer.tsx";
import { usePageHeader } from "@/components/layout/page-header.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useAccounts, type TradePreview } from "@/lib/queries.ts";
import { useTradePreview } from "@/lib/mutations.ts";

const selectClass = "border-input bg-background h-9 w-full min-w-0 rounded-md border px-3 text-sm disabled:opacity-50";
const gold = (value: number) => value.toLocaleString("zh-CN");

export default function TradePreviewPage() {
  usePageHeader("金币交易预览", "选择两个账号，查看到账金额、手续费和候选装备");
  const accounts = useAccounts();
  const preview = useTradePreview();
  const [payerId, setPayerId] = useState("");
  const [receiverId, setReceiverId] = useState("");
  const [amount, setAmount] = useState("");
  const amountNumber = Number(amount);
  const amountValid = /^\d+$/.test(amount) && Number.isSafeInteger(amountNumber) && amountNumber > 0;
  const valid = !!payerId && !!receiverId && payerId !== receiverId && amountValid;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (valid && !preview.isPending) preview.mutate({ payerAccountId: payerId, receiverAccountId: receiverId, amount: amountNumber });
  }

  if (accounts.isPending) return <PageContainer><Skeleton className="h-64" /></PageContainer>;
  if (accounts.isError) return (
    <PageContainer><Alert variant="destructive"><AlertDescription>{accounts.error.message}</AlertDescription></Alert></PageContainer>
  );
  if (accounts.data.length < 2) return (
    <PageContainer>
      <EmptyState icon={<IconCoins />} title="需要两个游戏账号" description="先添加付款和收款使用的游戏账号，再生成交易预览。"
        action={<Button asChild><Link to="/accounts">去账号页</Link></Button>} />
    </PageContainer>
  );

  return (
    <PageContainer>
      <div className="space-y-4">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2">交易预览 <Badge variant="secondary">仅预览</Badge></CardTitle></CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={submit}>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="min-w-0 space-y-1.5">
                  <span className="text-sm font-medium">付款账号</span>
                  <select className={selectClass} value={payerId} required disabled={preview.isPending}
                    onChange={(event) => { setPayerId(event.target.value); preview.reset(); }}>
                    <option value="">请选择付款账号</option>
                    {accounts.data.map((account) => <option key={account.id} value={account.id} disabled={account.id === receiverId}>
                      {account.label}{account.player?.nickname ? `（${account.player.nickname}）` : ""}
                    </option>)}
                  </select>
                </label>
                <label className="min-w-0 space-y-1.5">
                  <span className="text-sm font-medium">收款账号</span>
                  <select className={selectClass} value={receiverId} required disabled={preview.isPending}
                    onChange={(event) => { setReceiverId(event.target.value); preview.reset(); }}>
                    <option value="">请选择收款账号</option>
                    {accounts.data.map((account) => <option key={account.id} value={account.id} disabled={account.id === payerId}>
                      {account.label}{account.player?.nickname ? `（${account.player.nickname}）` : ""}
                    </option>)}
                  </select>
                </label>
              </div>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">希望收款账号实际到账的金币</span>
                <Input value={amount} onChange={(event) => { setAmount(event.target.value); preview.reset(); }}
                  inputMode="numeric" pattern="[0-9]+" placeholder="例如：1000000" required disabled={preview.isPending}
                  aria-describedby="trade-amount-hint" aria-invalid={!!amount && !amountValid} />
                <span id="trade-amount-hint" className="text-muted-foreground block text-xs">
                  {amount && !amountValid ? "请输入有效的正整数，不含逗号、小数或单位。" : "填写正整数，手续费会计入付款账号需要支付的金额。"}
                </span>
              </label>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <Button type="submit" disabled={!valid || preview.isPending}>
                  {preview.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconCoins className="size-4" />}
                  {preview.isPending ? "正在读取数据…" : "生成预览"}
                </Button>
                <p className="text-muted-foreground text-xs">只读取当前数据，不上架装备、不购买、不扣金币。</p>
              </div>
            </form>
          </CardContent>
        </Card>
        {preview.isError ? <Alert variant="destructive"><IconAlertTriangle /><AlertDescription>{preview.error.message}</AlertDescription></Alert> : null}
        {preview.data ? <PreviewResult preview={preview.data} /> : null}
      </div>
    </PageContainer>
  );
}

function PreviewResult({ preview }: { preview: TradePreview }) {
  const candidate = preview.candidate;
  const amounts = [
    { label: "付款账号需支付", value: preview.grossGold },
    { label: "市场手续费", value: preview.feeGold },
    { label: "收款账号预计到账", value: preview.netGold },
  ];
  return (
    <div className="space-y-4" aria-live="polite">
      {preview.issues.length ? (
        <Alert variant="destructive"><IconAlertTriangle /><AlertDescription>
          <p className="font-medium">当前条件尚不满足</p>
          <ul className="list-disc space-y-1 pl-4">{preview.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
        </AlertDescription></Alert>
      ) : null}
      <Card>
        <CardHeader><CardTitle>预计金额</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-4 sm:grid-cols-3">
            {amounts.map(({ label, value }) => (
              <div key={label} className="bg-muted/40 min-w-0 rounded-lg p-4">
                <dt className="text-muted-foreground text-xs">{label}</dt>
                <dd className="mt-2 break-all text-xl font-semibold tabular-nums">{gold(value)}<span className="ml-1 text-xs font-normal">金币</span></dd>
              </div>
            ))}
          </dl>
          <p className="text-muted-foreground text-xs">当前成交税率：{(preview.feeBasisPoints / 100).toFixed(2)}%，按游戏的取整方式计算。</p>
          <dl className="grid gap-3 border-t pt-4 text-sm sm:grid-cols-2">
            <div><dt className="text-muted-foreground">付款账号当前金币 · {preview.payer.nickname}</dt><dd className="mt-1 tabular-nums">{gold(preview.payer.gold)}</dd></div>
            <div><dt className="text-muted-foreground">收款账号当前金币 · {preview.receiver.nickname}</dt><dd className="mt-1 tabular-nums">{gold(preview.receiver.gold)}</dd></div>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>候选装备</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {candidate ? <>
            <p className="font-medium">{candidate.name} · {candidate.rarityLabel} · 品质 {candidate.quality} · 强化 +{candidate.upgradeLevel}</p>
            <dl className="grid gap-3 sm:grid-cols-2">
              <div><dt className="text-muted-foreground">最低上架价</dt><dd>{gold(candidate.minimumPrice)} 金币</dd></div>
              <div><dt className="text-muted-foreground">NPC 回收价</dt><dd>{gold(candidate.sellValue)} 金币</dd></div>
            </dl>
            <p className="text-muted-foreground text-xs">共 {preview.candidateCount} 件符合条件，优先展示回收价较低的装备。装备尚未上架或预留。</p>
          </> : <p className="text-muted-foreground">没有符合当前金额和交易条件的候选装备。</p>}
          <p className="text-muted-foreground border-t pt-3 text-xs">数据读取于 {new Date(preview.createdAt).toLocaleString("zh-CN")}。金币、市场配置或背包变化后，请重新生成预览。</p>
        </CardContent>
      </Card>
    </div>
  );
}
