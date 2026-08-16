# Folder Ownership Inventory

`cmd/ownership-inventory` 是只读治理命令，用 Grafana Folder API 的当前结果与 Provider 原生 ownership 事实对账。
它不会删除、迁移、改名或修改 owner，也不会建立资源映射表。

命令复用 Control Plane 的 Dagu/Knowledge Provider 环境变量和凭据，并额外要求 Grafana 管理员只读调用凭据：

```bash
go run ./cmd/ownership-inventory \
  -grafana-url http://localhost:3000 \
  -username admin \
  -password-file deploy/local/secrets/grafana-admin-password \
  -tenant-id local \
  -org-id 1
```

输出是 JSON：`folders` 来自本次 Grafana API 查询；`resources` 中每个根资源状态为：

- `active`：Provider owner 与一个现存 Folder 匹配；
- `orphan`：Folder-owned 原生 owner 无任何现存 Folder 匹配；
- `legacy`：仍是迁移期用户/Org scope，不把它误判为已删除 Folder；
- `invalid`：Aegis-managed 资源的 ID 或原生 ownership metadata 损坏。

Dagu 只读取原生 labels；RAGFlow 只读取 Dataset description metadata；RAGLite 通过服务 Token 访问内部只读
`/v1/admin/ownership-inventory`，直接枚举 SQLite 中的 Collection manifest。哈希 owner 不可逆时只输出
`owner_key`，不伪造 Folder UID。输出应进入受控安全日志或指标，不应直接暴露给普通 Folder 用户。

治理人员确认 orphan 后的迁移、归档或删除仍是独立 Admin 流程；本命令不授权这些操作。默认本地的 `infra` 和
`payment` 会由 Grafana API 自动发现，无需手工传 Folder 列表。
