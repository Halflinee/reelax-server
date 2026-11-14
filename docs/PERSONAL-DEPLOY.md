# 个人版本部署说明

代码仓库：`Halflinee/reelax-server`。
运行镜像：`ghcr.io/halflinee/reelax-server:latest`。

修改代码后提交到自己的 GitHub，由 Actions 检查并构建镜像，再让腾讯云服务器更新。
不需要在 2GB 内存的服务器上编译。上传的是程序代码，服务器的 `.env`、账号数据库和凭证不上传。
项目 `.npmrc` 将上游锁文件中的镜像源映射到官方 npm 源，以兼容 npm 12 的下载来源检查，不修改依赖版本或放宽安装策略。

## 1. 首次准备 GitHub

1. 在 GitHub 上 Fork `Creator2K/reelax-server`，Owner 选择 `Halflinee`，名称保留 `reelax-server`。
2. 打开自己的仓库，进入 **Actions**。若显示 Fork 工作流尚未启用，按页面提示启用。
3. 将本地准备好的更改提交到自己仓库的 `main`。之后每次提交都会运行 `CI`。
4. 等待 **类型检查 / Lint / 测试 / 构建** 和 **构建并推送镜像（GHCR）** 两项成功。
5. 首次镜像发布后，进入个人 GitHub 页面的 **Packages → reelax-server → Package settings**，将镜像可见性设为 **Public**。
   新镜像默认可能是 Private；Public 才能让服务器无需保存 GitHub 访问令牌就拉取。公开范围是程序镜像，镜像中不能包含个人凭证或私有数据。

需要手动构建时，在 **Actions → CI → Run workflow** 中选择 `main` 并运行。
工作流只在检查通过后发布镜像，PR 不发布。

## 2. 本地修改和提交

本地目录为 `H:\Work\reelax-server`，不要在其他项目目录里执行以下命令。

`origin` 指向自己的 Fork，`upstream` 指向作者仓库。

```powershell
cd H:\Work\reelax-server
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run lint
npm test
npm run build
```

修改完成后，用 `git status`、`git diff` 检查实际改动，明确选择要提交的文件，然后提交并推送：

```powershell
git add <本次修改的文件>
git commit -m "说明本次功能改动"
git push origin main
```

首次推送需要本机 Git 的 GitHub 授权。如果弹出浏览器登录，确认使用 `Halflinee` 账号完成授权；无需把访问令牌交给聊天。聊天中的 GitHub 连接与电脑 Git 的登录状态彼此独立。

不要提交 `.env`、运行数据、API Key、游戏密码或 Cookie。现有 `.gitignore` 和 `.dockerignore` 已排除环境文件和运行数据，提交前仍需确认没有把凭证写进源码。

## 3. 现有腾讯云服务器首次切换

以下步骤在 **OrcaTerm** 执行。每一步成功后再继续，任何一步报错都先停下检查。
只有备份时和重建应用容器时会短暂中断挂机。Caddy、免费网址和防火墙规则不需要重装。

### 保存当前设置和旧镜像信息

```bash
sudo -i
cd /opt/reelax-server
umask 077
backup_dir="/root/reelax-backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
cp -p .env docker-compose.yml "$backup_dir/"
docker inspect --format '{{.Image}}' reelax-server > "$backup_dir/image-id.txt"
```

首次切换前，确认项目目录中没有已有的 `docker-compose.override.yml`。如果存在，先比较内容，不直接覆盖。

### 下载个人配置并验证，先不停止旧程序

```bash
curl -fL https://raw.githubusercontent.com/Halflinee/reelax-server/main/docker-compose.override.yml -o "$backup_dir/docker-compose.override.yml.new"
docker compose -f docker-compose.yml -f "$backup_dir/docker-compose.override.yml.new" config -q
docker compose -f docker-compose.yml -f "$backup_dir/docker-compose.override.yml.new" config --images
docker compose -f docker-compose.yml -f "$backup_dir/docker-compose.override.yml.new" pull app
```

镜像列表应显示 `ghcr.io/halflinee/reelax-server:latest`。
如果拉取出现 `denied` 或 `unauthorized`，检查 GitHub Actions 是否已经成功发布，以及 Package 是否为 Public；不要继续停止旧程序。

### 暂停并备份完整数据，再切换镜像

保持同一个 OrcaTerm 窗口，依次执行：

```bash
docker compose stop app
docker cp reelax-server:/app/data "$backup_dir/data"
```

复制成功后继续；如果复制失败，执行 `docker compose start app` 恢复原程序，先处理备份错误。

```bash
cp "$backup_dir/docker-compose.override.yml.new" docker-compose.override.yml
docker compose up -d --no-build app
docker compose ps
curl -f http://127.0.0.1:8580/api/health
```

首次启动可能需要稍等，健康检查成功后刷新网站，确认原账号、配置和挂机状态。
`latest` 会指向个人仓库最近成功发布的版本；不能只靠应用版本号判断某次自定义改动是否已部署，可以结合 GitHub Actions 提交号和后台版本信息确认。

如果新版启动失败，查看 `docker compose logs --tail=80 app`，保留备份和旧镜像信息。新版可能迁移数据库，不应在未确认数据兼容时直接换回旧镜像。

备份中包含 `.env` 和账号资料，另存到自己的电脑时妥善保管，不公开上传。
不要删除数据卷、不要运行 `docker compose down -v`、不要重新生成 `MASTER_KEY`。
主配置中的项目名 `reelax-server` 和数据卷 `reelax-data` 必须保留。

## 4. 以后更新个人版本

1. 在电脑上修改、检查、提交并推送代码。
2. 等自己的 GitHub Actions 检查和镜像发布成功。
3. 在 OrcaTerm 执行一次 `sudo reelax-update`，自动下载、备份、更新并检查。

### 一次性安装更新命令

已经切换到个人镜像的服务器，在 OrcaTerm 执行以下整段。安装本身不会重启程序。

```bash
(
set -eu
script_file=$(mktemp)
trap 'rm -f "$script_file"' EXIT
curl -fL https://raw.githubusercontent.com/Halflinee/reelax-server/main/scripts/update-image.sh -o "$script_file"
bash -n "$script_file"
sudo install -o root -g root -m 755 "$script_file" /usr/local/sbin/reelax-update
echo "安装完成，以后执行 sudo reelax-update"
)
```

以后每次更新只运行：

```bash
sudo reelax-update
```

脚本先下载 `ghcr.io/halflinee/reelax-server:latest`，下载失败不会停止原程序。下载完成后保存 `.env`、两份 Compose 配置和旧镜像 ID，暂停 `app`，复制完整 `/app/data`（数据库、账号配置、日志、微信凭证等），随后启动新版并检查健康接口。Caddy 不重启。

备份保存在 `/root/reelax-backups/日期时间-随机后缀/`，目录中的 `backup.complete` 表示备份已完整复制。配置备份失败不会停机；停机后数据备份失败，会尝试重新启动原容器。新版启动或健康检查失败时明确报错，保留完整备份，不自动降级数据库。

备份只保存在服务器本机，含账号凭证和主密钥，仅 root 可读取。每次更新且健康检查成功后，自动保留最近 **5 次完整备份**，删除更早的完整备份（按目录名中的创建时间排序，同一秒内的旧备份按名称排序，当前备份始终保留）。更新失败时不清理；未完成的备份、手工创建的目录和符号链接不自动删除。重要备份另外下载保存。

脚本本身有修改时，重新执行一次安装步骤即可更新该命令；只更新 Docker 镜像不会更新宿主机上的 `reelax-update`。重新安装不会立刻清理备份，下一次执行 `sudo reelax-update` 且健康检查成功后才清理。

脚本通过个人覆盖配置选择镜像，不拉源码、不在服务器编译、不修改 `.env` 或数据卷。显式执行 `docker compose -f docker-compose.yml ...` 会忽略个人覆盖文件，日常更新请使用 `sudo reelax-update`。

作者后续有更新时，可通过 Fork 的 **Sync fork** 或在本地合并 `upstream/main` 引入；存在冲突时先处理和验证，不强制覆盖自己的功能。
