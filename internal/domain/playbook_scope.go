package domain

import (
	"crypto/sha256"
	"encoding/base64"
	"strings"
)

// PlaybookScopeKey 生成包含 Grafana Folder 的稳定不可逆摘要，用于 Aegis 管理的 Dagu 文件名。
// 该摘要只做快速隔离，最终授权仍以 Dagu YAML 的 ownership labels 为准。
func PlaybookScopeKey(actor ActorContext) string {
	sum := sha256.Sum256([]byte(actor.TenantID + "\x00" + actor.OrgID + "\x00" + actor.FolderUID))
	return base64.RawURLEncoding.EncodeToString(sum[:8])
}

// PlaybookLegacyScopeKey 仅在有限的只读迁移窗口内识别旧 Org-scoped 文件名，禁止用于创建新资源。
func PlaybookLegacyScopeKey(actor ActorContext) string {
	sum := sha256.Sum256([]byte(actor.TenantID + "\x00" + actor.OrgID))
	return base64.RawURLEncoding.EncodeToString(sum[:8])
}

func PlaybookIDInScope(id ID, actor ActorContext) bool {
	return strings.HasPrefix(string(id), "pbk_"+PlaybookScopeKey(actor)+"_")
}

func PlaybookIDInLegacyScope(id ID, actor ActorContext) bool {
	return strings.HasPrefix(string(id), "pbk_"+PlaybookLegacyScopeKey(actor)+"_")
}

func PlaybookIDVisibleInScope(id ID, actor ActorContext) bool {
	return PlaybookIDInScope(id, actor) || PlaybookIDInLegacyScope(id, actor)
}
