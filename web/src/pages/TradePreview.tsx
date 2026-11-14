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
import { useAccounts, useGoldTransfer, useGoldTransferHistory, type TradePreview, type GoldTransfer } from "@/lib/queries.ts";
import { useTradePreview, useGoldTransferAction } from "@/lib/mutations.ts";
import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel } from "@/components/ui/alert-dialog.tsx";

const selectClass = "border-input bg-background h-9 w-full min-w-0 rounded-md border px-3 text-sm disabled:opacity-50";
const gold = (value: number) => value.toLocaleString("zh-CN");

export default function TradePreviewPage() {
  usePageHeader("金币集中", "选择两个账号，先预览金额和装备，再手动确认交易");
  const accounts = useAccounts();
  const preview = useTradePreview();
  const confirm = useGoldTransferAction("confirm");
  const history = useGoldTransferHistory();
  const [operationId, setOperationId] = useState<string | null>(null);
  const operation = useGoldTransfer(operationId);
  const busy = confirm.isPending || operation.data?.status === "executing" || history.data?.some((item) => item.status === "executing");
  const [payerId, setPayerId] = useState("");
  const [receiverId, setReceiverId] = useState("");
  const [amount, setAmount] = useState("");
  const amountNumber = Number(amount);
  const amountValid = /^\d+$/.test(amount) && Number.isSafeInteger(amountNumber) && amountNumber > 0;
  const valid = !!payerId && !!receiverId && payerId !== receiverId && amountValid;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (valid && !preview.isPending && !busy) {
      setOperationId(null); confirm.reset();
      preview.mutate({ payerAccountId: payerId, receiverAccountId: receiverId, amount: amountNumber });
    }
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
          <CardHeader><CardTitle className="flex items-center gap-2">准备金币交易 <Badge variant="secondary">手动确认</Badge></CardTitle></CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={submit}>
              <fieldset disabled={!!busy || preview.isPending} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="min-w-0 space-y-1.5">
                  <span className="text-sm font-medium">付款账号</span>
                  <select className={selectClass} value={payerId} required disabled={preview.isPending}
                    onChange={(event) => { setPayerId(event.target.value); preview.reset(); setOperationId(null); }}>
                    <option value="">请选择付款账号</option>
                    {accounts.data.map((account) => <option key={account.id} value={account.id} disabled={account.id === receiverId}>
                      {account.label}{account.player?.nickname ? `（${account.player.nickname}）` : ""}
                    </option>)}
                  </select>
                </label>
                <label className="min-w-0 space-y-1.5">
                  <span className="text-sm font-medium">收款账号</span>
                  <select className={selectClass} value={receiverId} required disabled={preview.isPending}
                    onChange={(event) => { setReceiverId(event.target.value); preview.reset(); setOperationId(null); }}>
                    <option value="">请选择收款账号</option>
                    {accounts.data.map((account) => <option key={account.id} value={account.id} disabled={account.id === payerId}>
                      {account.label}{account.player?.nickname ? `（${account.player.nickname}）` : ""}
                    </option>)}
                  </select>
                </label>
              </div>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">希望收款账号实际到账的金币</span>
                <Input value={amount} onChange={(event) => { setAmount(event.target.value); preview.reset(); setOperationId(null); }}
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
                <p className="text-muted-foreground text-xs">生成预览不交易；之后手动确认，才会上架装备并购买。</p>
              </div>
              </fieldset>
            </form>
          </CardContent>
        </Card>
        {preview.isError ? <Alert variant="destructive"><IconAlertTriangle /><AlertDescription>{preview.error.message}</AlertDescription></Alert> : null}
        {preview.data ? <PreviewResult preview={preview.data} /> : null}
        {preview.data?.confirmation && !preview.data.issues.length && preview.data.candidate ? <ConfirmTransfer preview={preview.data}
          disabled={!!busy || history.isPending || history.isError || history.data?.some((item) => item.id === preview.data?.confirmation?.id) === true
            || (operation.data?.id === preview.data.confirmation.id && operation.data.status !== "previewed")}
          onConfirm={() => { const id = preview.data!.confirmation!.id; setOperationId(id); confirm.mutate(id); }} /> : null}
        {confirm.isError ? <Alert variant="destructive"><AlertDescription>{confirm.error.message}。请先查看当前记录的状态。</AlertDescription></Alert> : null}
        {operation.isError ? <Alert variant="destructive"><AlertDescription>交易状态读取失败：{operation.error.message}
          <Button variant="outline" size="sm" onClick={() => void operation.refetch()}>刷新状态</Button>
        </AlertDescription></Alert> : null}
        {operation.data ? <TransferStatus operation={operation.data} /> : null}
        {history.isError ? <Alert variant="destructive"><AlertDescription>交易记录读取失败：{history.error.message}
          <Button variant="outline" size="sm" onClick={() => void history.refetch()}>重新读取记录</Button>
        </AlertDescription></Alert> : null}
        {history.data?.length ? <Card><CardHeader><CardTitle>最近交易记录</CardTitle></CardHeader><CardContent className="space-y-2">
          {history.data.map((item) => <button type="button" key={item.id} className="hover:bg-muted/50 flex w-full flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-left text-sm"
            onClick={() => setOperationId(item.id)}>
            <span>{item.preview.payer.label}（{item.preview.payer.nickname}）→ {item.preview.receiver.label}（{item.preview.receiver.nickname}）· {gold(item.preview.netGold)} 金币</span>
            <span className="text-muted-foreground text-xs">{statusLabel[item.status]} · {new Date(item.createdAt).toLocaleString("zh-CN")}</span>
          </button>)}
        </CardContent></Card> : null}
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
            <div><dt className="text-muted-foreground">付款账号预览时金币 · {preview.payer.nickname}</dt><dd className="mt-1 tabular-nums">{gold(preview.payer.gold)}</dd></div>
            <div><dt className="text-muted-foreground">收款账号预览时金币 · {preview.receiver.nickname}</dt><dd className="mt-1 tabular-nums">{gold(preview.receiver.gold)}</dd></div>
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

const statusLabel: Record<GoldTransfer["status"], string> = {
  previewed: "待确认", executing: "进行中", completed: "已完成", failed: "未发起交易", review_required: "需要核对", closed: "已手动结束",
};

function ConfirmTransfer({ preview, disabled, onConfirm }: { preview: TradePreview; disabled: boolean; onConfirm: () => void }) {
  return <Card><CardContent className="space-y-3 pt-5">
    <p className="text-sm">确认后，收款账号会公开上架 <strong>{preview.candidate!.name}</strong>，付款账号购买这件装备。装备最终归付款账号。</p>
    <AlertDialog>
      <AlertDialogTrigger asChild><Button disabled={disabled}>确认这笔交易</Button></AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>确认实际交易</AlertDialogTitle><AlertDialogDescription>
          付款账号 {preview.payer.label}（{preview.payer.nickname}）支付 {gold(preview.grossGold)} 金币；收款账号 {preview.receiver.label}（{preview.receiver.nickname}）预计收到 {gold(preview.netGold)} 金币，手续费 {gold(preview.feeGold)} 金币。
          使用装备：{preview.candidate!.name}（品质 {preview.candidate!.quality}，强化 +{preview.candidate!.upgradeLevel}）。确认后会真实上架和扣款。
        </AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>返回检查</AlertDialogCancel><AlertDialogAction onClick={onConfirm} disabled={disabled}>确认并交易</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <p className="text-muted-foreground text-xs">本次确认有效至 {new Date(preview.confirmation!.expiresAt).toLocaleTimeString("zh-CN")}。交易前会重新核对条件。</p>
  </CardContent></Card>;
}

function TransferStatus({ operation }: { operation: GoldTransfer }) {
  const check = useGoldTransferAction("check");
  const close = useGoldTransferAction("close");
  const busy = check.isPending || close.isPending;
  return <Card><CardHeader><CardTitle>{statusLabel[operation.status]}</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
    <p>{operation.preview.payer.label}（{operation.preview.payer.nickname}）→ {operation.preview.receiver.label}（{operation.preview.receiver.nickname}）· {operation.preview.candidate?.name}</p>
    <p>{operation.message}</p>
    {operation.orderId ? <p className="text-muted-foreground break-all text-xs">订单号：{operation.orderId}</p> : null}
    {operation.settlement ? <p>实际支付 {gold(operation.settlement.grossGold)} 金币 · 手续费 {gold(operation.settlement.feeGold)} 金币 · 实际到账 {gold(operation.settlement.netGold)} 金币</p> : null}
    {operation.status === "review_required" ? <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={busy} onClick={() => check.mutate(operation.id)}>{check.isPending ? "正在核对…" : "核对成交结果"}</Button>
      <AlertDialog>
        <AlertDialogTrigger asChild><Button variant="outline" disabled={busy}>已在游戏内核对，结束记录</Button></AlertDialogTrigger>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>确认已人工核对</AlertDialogTitle><AlertDialogDescription>
          请先检查双方成交记录，并在游戏内取消仍未成交的挂单。结束记录不会退款、撤单或再次交易，只解除这条待核对记录对后续操作的限制。
        </AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>返回核对</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={() => close.mutate(operation.id)}>我已核对，结束记录</AlertDialogAction>
        </AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </div> : null}
    {check.isError || close.isError ? <p role="alert" className="text-destructive">{check.error?.message ?? close.error?.message}</p> : null}
  </CardContent></Card>;
}
