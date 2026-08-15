# Canvas SQLite 备份与恢复

Canvas SQLite 只保存 Query/Chart/Canvas 投影，不保存 Session、Turn、Message、工具结果或查询样本。
备份必须使用 SQLite backup API，不能只复制运行中的 `.db` 文件；运行中的数据库可能还有 `-wal` 和
`-shm` 内容。

## 备份

先让当前实例停止接收写请求，再执行：

```sh
scripts/backup-canvas.sh /var/lib/aegis/canvas/canvas.db /secure-backup/aegis-canvas-2026-08-15.db
```

脚本会执行 `quick_check`、SQLite `.backup` 和恢复前 `integrity_check`，并拒绝覆盖已有备份。
生产环境应把备份文件交给加密备份系统，并单独保管 Agent identity key 和 MCP token。

## 恢复

恢复前停止对应的单实例 Control Plane，并把目标文件移到临时目录验证：

```sh
scripts/restore-canvas.sh /secure-backup/aegis-canvas-2026-08-15.db /var/lib/aegis/canvas/canvas.db
```

脚本拒绝覆盖现有数据库，验证通过后使用同目录原子替换。恢复后启动相同版本或兼容窗口内的 Control
Plane，检查 `/health/ready` 的 `canvas=available`，再打开一个已知 Session 验证 revision、Chart
定义和布局。旧二进制不得对新 migration 执行写入。

## 本地 Compose

本 workspace 的 Compose 项目名必须显式隔离：

```sh
docker compose -p aegis-sre-audit-canvas up -d --build
docker compose -p aegis-sre-audit-canvas ps
```

不得使用未带 `-p aegis-sre-audit-canvas` 的 `up`、`down`、`logs` 或 `ps`。
