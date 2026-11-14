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
import { useAccounts, type MasteryTransferPreview } from "@/lib/queries.ts";
import { useMasteryTransferPreview } from "@/lib/mutations.ts";

const selectClass = "border-input bg-background h-9 w-full min-w-0 rounded-md border px-3 text-sm disabled:opacity-50";
const number = (value: number) => value.toLocaleString("zh-CN");

export default function MasteryTransferPreviewPage() {
  usePageHeader("专精鱼调配预览", "按两个账号当前的专精目标，查看缺口、富余和交换建议");
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
      </CardContent>
    </Card>)}
  </div>;
}
