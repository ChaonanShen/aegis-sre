package domain

import (
	"crypto/sha256"
	"encoding/base64"
	"strings"
)

// PlaybookScopeKey derives the stable, non-reversible Grafana organization scope
// embedded in Aegis-managed Dagu filenames. It prevents another organization
// from discovering or mutating a Playbook through a guessed public ID.
func PlaybookScopeKey(actor ActorContext) string {
	sum := sha256.Sum256([]byte(actor.TenantID + "\x00" + actor.OrgID))
	return base64.RawURLEncoding.EncodeToString(sum[:8])
}

func PlaybookIDInScope(id ID, actor ActorContext) bool {
	return strings.HasPrefix(string(id), "pbk_"+PlaybookScopeKey(actor)+"_")
}
