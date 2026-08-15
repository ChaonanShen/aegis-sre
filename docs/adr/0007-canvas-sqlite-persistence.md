# ADR 0007：Canvas 使用最小 SQLite 持久化

- 状态：接受
- 日期：2026-08-15
- 适用范围：阶段 7.1 Query-backed Chart 与 Canvas

## 背景

Agent Provider 能持久化 Session、Turn、Message、工具调用和审批，但不能可靠承载 Aegis 产品专有的
Canvas 布局。Grafana MCP 可以查询数据，却不保存任意 PromQL 对应的 Workbench Canvas。若只在浏览器
解析工具参数，刷新、断线或重新打开 Session 后都会丢失图表定义。

Canvas 恢复只需要 datasource UID、PromQL、绝对时间范围、step、VizConfig 和布局；指标样本仍由
Prometheus/Grafana 拥有，不需要复制。该状态经过持久化决策门验证，无法由 Agent Provider 或 Grafana
原生资源在不引入第二事实来源的前提下承载。

## 决策

1. Aegis 使用 SQLite 保存独立的 Canvas 产品投影。首版固定纯 Go 驱动
   `modernc.org/sqlite v1.56.0`，保持 `CGO_ENABLED=0`，不引入 ORM。
2. SQLite 只包含 migration、Canvas、Query Definition、Chart Definition 和 Canvas Item。禁止建立
   Session、Turn、Message、Event、Provider 映射或查询结果表。
3. 所有记录按可信 Tenant、Org、User 和 Provider-neutral 的公开 Session ID 分区。数据库不建立
   Session 外键；应用服务在每次读写前通过 `AgentProvider.ReadSession` 重新验证会话和 Actor scope。
4. 首版只支持 Prometheus range Query-backed Chart。Query 保存 datasource UID、PromQL、绝对 UTC
   时间范围和 step；Chart 保存展示元数据、规范化 VizConfig 和 Query 引用；Canvas 保存显示状态、
   布局、成员顺序、active chart 和 revision。不得保存样本、Grafana 响应、工具结果或截图。
5. Agent 通过受控的 Aegis Canvas MCP 发布图表。Codex 与 OpenCode 使用相同工具契约；工具调用使用
   独立 Token 并绑定服务端 Actor。发布以 idempotency key 和 canonical request hash 去重，在一个
   SQLite 事务内写入完整聚合。
6. Canvas HTTP API 使用 revision/ETag 做乐观并发。客户端只能调整显示、布局、顺序、active chart
   和删除成员，不能通过布局接口修改 Query/VizConfig 或添加未知 Chart。
7. Archive/Unarchive 保留 Canvas，归档时只读。删除 Agent Session 成功或幂等重试确认其已不存在后，
   删除同 scope 的 Canvas 聚合；清理失败必须显式返回可重试错误。
8. SQLite 首版只支持单 Control Plane 实例、单写者和本地持久卷，不支持共享网络文件系统或多副本。
   后续扩展通过替换 `CanvasStore` adapter 完成，不改变公共 API 或领域模型。
9. 数据库启用 WAL、外键、`synchronous=FULL` 和 busy timeout。迁移在服务启动前执行且只前进；未知
   Schema、checksum 漂移、损坏库或不可写目录均 fail-closed。备份必须使用 SQLite backup API 或
   停写后的一致快照，恢复前执行完整性检查。
10. 普通 PNG/JPEG/SVG 等 Artifact 继续使用受控资源引用，不进入本 Schema，也不阻塞本切片。

## 数据生命周期

- 首次发布 Chart 时惰性创建 Canvas；没有持久记录时 API 返回 revision 0 的空投影。
- Query version 是不可变记录；Chart 首版创建后只允许删除，不提供查询编辑。
- 布局写入和 Chart 发布都会递增 Canvas revision。重复发布同 key/同 payload 返回原结果。
- 删除 Chart 时同步删除无引用 Query；删除 Session 时删除整个 Canvas 聚合。
- 数据库文件及 WAL 进入独立持久卷和备份流程，不与 Agent Provider 数据目录混放。

## 结果

- 刷新、重开会话和 Control Plane 重启后可以恢复 Canvas，再按当前 Grafana 权限重新查询绘图。
- Control Plane 从“完全无状态”调整为“只持久化明确归 Aegis 所有的 Canvas 产品投影”，但不复制
  Provider 数据，也不建立 Agent 会话影子库。
- SQLite 限制了首版 Control Plane 的横向扩展；在采用多副本前必须迁移到支持共享并发的 Store adapter。
- 数据源失权或删除时定义仍保留，插件显示可恢复错误；数据库中始终没有指标样本。

## 验收门禁

- Schema 结构测试证明不存在 Session/Message/Event 和样本/结果字段。
- SQLite 重开、容器重启、备份恢复、迁移、事务回滚、幂等和 revision 冲突测试通过。
- Codex/OpenCode 合同测试使用同一 Canvas MCP 完成发布，失败查询不产生记录。
- 真实 E2E 在刷新和重启后重新查询 Grafana 并绘制，不读取 fixture 或截图。
