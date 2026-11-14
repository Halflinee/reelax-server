#!/usr/bin/env bash
# 用隔离目录和模拟 Docker 验证更新顺序与失败恢复，不接触真实容器。
set -euo pipefail
SOURCE_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(mktemp -d)
[[ $ROOT == /tmp/tmp.* ]] || { echo '临时目录不在预期位置'; exit 1; }
trap 'rm -rf -- "$ROOT"' EXIT
mkdir -p "$ROOT/bin"

cat > "$ROOT/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$CASE_DIR/commands"
if [[ $1 == compose ]]; then
    shift 5
    case "$1" in
        config)
            [[ $2 != --images ]] || printf '%s\n' "${TEST_IMAGE:-ghcr.io/halflinee/reelax-server:latest}"
            ;;
        ps) echo old-container ;;
        pull) [[ $TEST_SCENARIO != pull-failure ]] ;;
        stop) touch "$CASE_DIR/stopped" ;;
        up)
            [[ -f $CASE_DIR/stopped ]]
            [[ -n $(find "$CASE_DIR/backups" -name backup.complete) ]]
            [[ $TEST_SCENARIO != start-failure ]]
            ;;
        exec)
            [[ $TEST_SCENARIO != health-failure ]] || exit 1
            echo '{"ok":true,"version":"test"}'
            ;;
        *) exit 90 ;;
    esac
elif [[ $1 == inspect ]]; then
    case "$3" in
        '{{.State.Running}}') echo true ;;
        '{{.Image}}') echo sha256:old-image ;;
        *) exit 91 ;;
    esac
elif [[ $1 == cp ]]; then
    [[ -f $CASE_DIR/stopped ]]
    [[ $TEST_SCENARIO != backup-failure ]] || exit 1
    mkdir -p "$3/wechat-creds"
    printf 'database including WAL\n' > "$3/reelax.db"
    printf 'uncheckpointed state\n' > "$3/reelax.db-wal"
    printf 'credential\n' > "$3/wechat-creds/test"
elif [[ $1 == start ]]; then
    touch "$CASE_DIR/resumed"
else
    exit 92
fi
MOCK
cat > "$ROOT/bin/id" <<'MOCK'
#!/usr/bin/env bash
echo 0
MOCK
cat > "$ROOT/bin/flock" <<'MOCK'
#!/usr/bin/env bash
[[ $TEST_SCENARIO != locked ]]
MOCK
cat > "$ROOT/bin/sleep" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
chmod +x "$ROOT/bin/"*
export PATH="$ROOT/bin:$PATH"

check_case() {
    export TEST_SCENARIO=$1
    export CASE_DIR="$ROOT/$1"
    mkdir -p "$CASE_DIR/deploy"
    printf 'MASTER_KEY=test-only\n' > "$CASE_DIR/deploy/.env"
    printf 'name: reelax-server\n' > "$CASE_DIR/deploy/docker-compose.yml"
    printf 'services: {}\n' > "$CASE_DIR/deploy/docker-compose.override.yml"
    # 只替换宿主机路径，运行的仍是完整生产脚本。
    sed -e "s|^DEPLOY_DIR=.*|DEPLOY_DIR='$CASE_DIR/deploy'|" \
        -e "s|^BACKUP_ROOT=.*|BACKUP_ROOT='$CASE_DIR/backups'|" \
        -e "s|^LOCK_FILE=.*|LOCK_FILE='$CASE_DIR/update.lock'|" \
        "$SOURCE_DIR/update-image.sh" > "$CASE_DIR/update.sh"
    status=0
    bash "$CASE_DIR/update.sh" > "$CASE_DIR/output" 2>&1 || status=$?
    if [[ $1 == success ]]; then
        [[ $status -eq 0 ]] || cat "$CASE_DIR/output"
        [[ $status -eq 0 ]]
        backup=$(find "$CASE_DIR/backups" -mindepth 1 -maxdepth 1 -type d)
        [[ -f $backup/backup.complete && -f $backup/data/reelax.db-wal && -f $backup/data/wechat-creds/test ]]
        [[ $(cat "$backup/image-id.txt") == sha256:old-image ]]
        for file in .env docker-compose.yml docker-compose.override.yml; do
            cmp "$CASE_DIR/deploy/$file" "$backup/$file"
        done
        # Windows 的 NTFS 不支持 Linux 权限语义，在 Ubuntu CI 上核对 700。
        if [[ $OSTYPE != msys* ]]; then
            [[ $(stat -c %a "$backup") == 700 ]]
        fi
        [[ ! -e $CASE_DIR/resumed ]]
        grep -q '更新完成，健康检查通过' "$CASE_DIR/output"
    else
        [[ $status -ne 0 ]]
        ! grep -q '更新完成，健康检查通过' "$CASE_DIR/output"
        case "$1" in
            pull-failure|locked|wrong-image)
                [[ ! -e $CASE_DIR/stopped && ! -d $CASE_DIR/backups ]]
                ;;
            backup-failure)
                [[ -f $CASE_DIR/resumed ]]
                ! grep -q 'up -d' "$CASE_DIR/commands"
                [[ -z $(find "$CASE_DIR/backups" -name backup.complete) ]]
                ;;
            start-failure|health-failure)
                [[ ! -e $CASE_DIR/resumed ]]
                [[ -n $(find "$CASE_DIR/backups" -name backup.complete) ]]
                ;;
        esac
    fi
    printf 'PASS %s\n' "$1"
}

check_case success
check_case pull-failure
check_case backup-failure
check_case start-failure
check_case health-failure
check_case locked
export TEST_IMAGE=ghcr.io/creator2k/reelax-server:latest
check_case wrong-image
