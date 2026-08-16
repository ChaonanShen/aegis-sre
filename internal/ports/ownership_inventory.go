package ports

import (
	"context"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
)

type OwnershipInventoryState string

const (
	OwnershipActive  OwnershipInventoryState = "active"
	OwnershipOrphan  OwnershipInventoryState = "orphan"
	OwnershipLegacy  OwnershipInventoryState = "legacy"
	OwnershipInvalid OwnershipInventoryState = "invalid"
)

// RootResourceOwnership 是只读治理投影；OwnerKey 只在无法恢复 Folder UID 时用于受控审计。
type RootResourceOwnership struct {
	Kind      string                  `json:"kind"`
	ID        domain.ID               `json:"id"`
	FolderUID string                  `json:"folder_uid,omitempty"`
	OwnerKey  string                  `json:"owner_key,omitempty"`
	State     OwnershipInventoryState `json:"state"`
}

// OwnershipInventoryProvider 由 Provider adapter 枚举原生 ownership 事实，不授权修改或删除。
type OwnershipInventoryProvider interface {
	InventoryOwnership(context.Context, domain.ActorContext, []string) ([]RootResourceOwnership, error)
}
