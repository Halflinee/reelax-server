#!/usr/bin/env bash
# 个人镜像更新：下载 -> 停机备份 -> 启动 -> 检查；在腾讯云宿主机运行。
set -Eeuo pipefail
umask 077

DEPLOY_DIR=/opt/reelax-server
BACKUP_ROOT=/root/reelax-backups
LOCK_FILE=/run/lock/reelax-update.lock

fail() { printf '更新未完成：%s\n' "$1" >&2; exit 1; }
step() { printf '\n==> %s\n' "$1"; }

[[ $# -eq 0 ]] || fail '此命令不需要参数。'
[[ $(id -u) -eq 0 ]] || fail '请使用 sudo reelax-update。'
for command in docker flock; do
    command -v "$command" >/dev/null || fail "找不到必需命令：$command"
done

# 锁由进程退出时自动释放，避免两个更新同时停机、备份。
exec 9>"$LOCK_FILE"
flock -n 9 || fail '另一个更新正在进行，请等待它完成。'

cd "$DEPLOY_DIR"
for file in .env docker-compose.yml docker-compose.override.yml; do
    [[ -f $file ]] || fail "缺少 $DEPLOY_DIR/$file，请先完成个人镜像切换。"
done
compose=(docker compose -f docker-compose.yml -f docker-compose.override.yml)
"${compose[@]}" config -q
image=$("${compose[@]}" config --images app)
[[ $image == ghcr.io/halflinee/reelax-server:latest ]] || fail '配置中的镜像不是自己的 latest 镜像，请先检查配置。'
container=$("${compose[@]}" ps -a -q app)
[[ -n $container ]] || fail '找不到现有应用容器，未执行更新。'
[[ $(docker inspect --format '{{.State.Running}}' "$container") == true ]] || fail '原程序没有运行，请先处理当前故障。'

backup_dir=
resume_old=0
finish() {
    result=$?
    trap - EXIT INT TERM
    # 只在新版尚未启动时恢复原容器；新版可能已迁移数据库，不能直接降级。
    if [[ $resume_old -eq 1 ]]; then
        if docker start "$container" >/dev/null; then
            printf '备份阶段中断，原容器已重新启动。\n' >&2
        else
            printf '原容器恢复失败，请检查 docker compose ps。\n' >&2
        fi
    fi
    if [[ $result -ne 0 ]]; then
        printf '操作失败，未报告更新成功。\n' >&2
        [[ -z $backup_dir ]] || printf '备份目录：%s（只有 backup.complete 存在才表示备份完整）\n' "$backup_dir" >&2
    fi
    exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

step '下载自己的最新镜像（此时原程序继续运行）'
"${compose[@]}" pull app

step '保存配置和旧镜像信息'
mkdir -p "$BACKUP_ROOT"
backup_dir=$(mktemp -d "$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)-XXXXXX")
cp -p .env docker-compose.yml docker-compose.override.yml "$backup_dir/"
docker inspect --format '{{.Image}}' "$container" > "$backup_dir/image-id.txt"

step '暂停程序，备份完整账号数据和凭证'
resume_old=1
"${compose[@]}" stop app
docker cp "$container:/app/data" "$backup_dir/data"
touch "$backup_dir/backup.complete"
printf '备份完成：%s\n' "$backup_dir"

step '启动新版'
resume_old=0
"${compose[@]}" up -d --no-build --pull never app

step '等待新版健康检查'
# 从容器内检查，避免宿主机端口绑定格式变化导致误判。
for ((attempt = 1; attempt <= 30; attempt++)); do
    if health=$("${compose[@]}" exec -T app node --input-type=module -e '
        try {
            const response = await fetch("http://127.0.0.1:8580/api/health", {
                signal: AbortSignal.timeout(2000)
            });
            const body = await response.json();
            if (!response.ok || body.ok !== true) process.exit(1);
            console.log(JSON.stringify(body));
        } catch { process.exit(1); }
    ' 2>/dev/null); then
        printf '\n更新完成，健康检查通过：%s\n备份位置：%s\n请刷新网站，确认原账号和新增功能。\n' "$health" "$backup_dir"
        exit 0
    fi
    sleep 2
done

fail '新版未通过健康检查。请在 /opt/reelax-server 执行 docker compose logs --tail=80 app 排查；备份已保留，未自动降级。'
