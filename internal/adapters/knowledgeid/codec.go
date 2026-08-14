// Package knowledgeid derives stable public Knowledge identifiers without a mapping database.
package knowledgeid

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"path/filepath"
	"strings"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
)

const datasetNamePrefix = "aegis__"

type Codec struct{ key []byte }

func New(key []byte) (*Codec, error) {
	if len(key) != 32 {
		return nil, errors.New("knowledge ID key must contain exactly 32 bytes")
	}
	return &Codec{key: append([]byte(nil), key...)}, nil
}

// CollectionID 把可信 Actor、Folder 和幂等键绑定到公开 ID；任一授权范围变化都会产生不同 ID。
func (codec *Codec) CollectionID(actor domain.ActorContext, idempotencyKey string) (domain.ID, error) {
	if err := actor.Validate(); err != nil {
		return "", err
	}
	if strings.TrimSpace(actor.FolderUID) == "" {
		return "", errors.New("folder UID is required")
	}
	if strings.TrimSpace(idempotencyKey) == "" {
		return "", errors.New("idempotency key is required")
	}
	return codec.derive("kbs_", "aegis-knowledge-collection-v1", actor.TenantID, actor.OrgID, actor.UserID, actor.FolderUID, idempotencyKey)
}

func (codec *Codec) DocumentID(collectionID domain.ID, idempotencyKey string) (domain.ID, error) {
	if !collectionID.Valid() || !strings.HasPrefix(string(collectionID), "kbs_") {
		return "", errors.New("valid knowledge base ID is required")
	}
	if strings.TrimSpace(idempotencyKey) == "" {
		return "", errors.New("idempotency key is required")
	}
	return codec.derive("doc_", "aegis-knowledge-document-v1", string(collectionID), idempotencyKey)
}

// ScopeFingerprint 可写入 Provider metadata 用于逐请求授权复核，且不泄漏 Actor 原始值。
func (codec *Codec) ScopeFingerprint(actor domain.ActorContext) (string, error) {
	if err := actor.Validate(); err != nil {
		return "", err
	}
	if strings.TrimSpace(actor.FolderUID) == "" {
		return "", errors.New("folder UID is required")
	}
	value, err := codec.derive("scp_", "aegis-knowledge-scope-v1", actor.TenantID, actor.OrgID, actor.UserID, actor.FolderUID)
	return string(value), err
}

func DatasetName(id domain.ID) (string, error) {
	if !id.Valid() || !strings.HasPrefix(string(id), "kbs_") {
		return "", errors.New("invalid knowledge base ID")
	}
	return datasetNamePrefix + string(id), nil
}

func PublicIDFromDatasetName(name string) (domain.ID, error) {
	id := domain.ID(strings.TrimPrefix(name, datasetNamePrefix))
	if name == string(id) || !id.Valid() || !strings.HasPrefix(string(id), "kbs_") {
		return "", errors.New("dataset is not managed by Aegis")
	}
	return id, nil
}

func DocumentName(id domain.ID, originalName string) (string, error) {
	if !id.Valid() || !strings.HasPrefix(string(id), "doc_") {
		return "", errors.New("invalid document ID")
	}
	ext := strings.ToLower(filepath.Ext(filepath.Base(originalName)))
	if len(ext) > 16 || strings.ContainsAny(ext, "/\\") {
		ext = ""
	}
	return datasetNamePrefix + string(id) + ext, nil
}

func (codec *Codec) derive(prefix, purpose string, fields ...string) (domain.ID, error) {
	mac := hmac.New(sha256.New, codec.key)
	writeField(mac, purpose)
	for _, field := range fields {
		writeField(mac, field)
	}
	id := domain.ID(prefix + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)[:18]))
	if !id.Valid() {
		return "", errors.New("derived knowledge ID does not satisfy the public contract")
	}
	return id, nil
}

func writeField(mac interface{ Write([]byte) (int, error) }, value string) {
	// 长度前缀避免不同字段组合或特殊字符产生相同的 HMAC 输入。
	var length [8]byte
	binary.BigEndian.PutUint64(length[:], uint64(len(value)))
	_, _ = mac.Write(length[:])
	_, _ = mac.Write([]byte(value))
}
