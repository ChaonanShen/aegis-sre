package agentid

import (
	"strings"
	"testing"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
)

func TestCodecProducesStableOpaquePublicID(t *testing.T) {
	t.Parallel()
	codec, _ := New([]byte("0123456789abcdef0123456789abcdef"))
	uuid := "01989f4a-3b2c-7def-8123-0123456789ab"
	first, err := codec.EncodeUUID(uuid)
	if err != nil {
		t.Fatal(err)
	}
	second, _ := codec.EncodeUUID(uuid)
	if first != second || !strings.HasPrefix(string(first), "ses_") || strings.Contains(string(first), "01989f4a") {
		t.Fatalf("public IDs are not stable and opaque: %q / %q", first, second)
	}
	decoded, err := codec.DecodeUUID(first)
	if err != nil || decoded != uuid {
		t.Fatalf("decoded = %q, err = %v", decoded, err)
	}
}

func TestCodecRejectsTamperingAndWrongKey(t *testing.T) {
	t.Parallel()
	codec, _ := New([]byte("0123456789abcdef0123456789abcdef"))
	id, _ := codec.EncodeUUID("01989f4a-3b2c-7def-8123-0123456789ab")
	tampered := []byte(id)
	if tampered[len(tampered)-1] == 'A' {
		tampered[len(tampered)-1] = 'B'
	} else {
		tampered[len(tampered)-1] = 'A'
	}
	if _, err := codec.DecodeUUID(domain.ID(tampered)); err == nil {
		t.Fatal("tampered ID must fail authentication")
	}
	other, _ := New([]byte("abcdef0123456789abcdef0123456789"))
	if _, err := other.DecodeUUID(id); err == nil {
		t.Fatal("ID encrypted with another key must fail")
	}
}

func TestCodecSeparatesSessionAndTurnNamespaces(t *testing.T) {
	t.Parallel()
	codec, _ := New([]byte("0123456789abcdef0123456789abcdef"))
	uuid := "01989f4a-3b2c-7def-8123-0123456789ab"
	turnID, err := codec.EncodeTurnUUID(uuid)
	if err != nil || !strings.HasPrefix(string(turnID), "turn_") {
		t.Fatalf("turn ID = %q, err = %v", turnID, err)
	}
	if decoded, err := codec.DecodeTurnUUID(turnID); err != nil || decoded != uuid {
		t.Fatalf("decoded = %q, err = %v", decoded, err)
	}
	if _, err := codec.DecodeUUID(turnID); err == nil {
		t.Fatal("turn ID must not decode as a session ID")
	}
	sessionID, _ := codec.EncodeUUID(uuid)
	if _, err := codec.DecodeTurnUUID(sessionID); err == nil {
		t.Fatal("session ID must not decode as a turn ID")
	}
}

func TestCodecProducesStableOneWayMessageID(t *testing.T) {
	t.Parallel()
	codec, _ := New([]byte("0123456789abcdef0123456789abcdef"))
	first, err := codec.EncodeMessageKey("provider-item-1")
	second, _ := codec.EncodeMessageKey("provider-item-1")
	other, _ := codec.EncodeMessageKey("provider-item-2")
	if err != nil || first != second || first == other || !strings.HasPrefix(string(first), "msg_") || strings.Contains(string(first), "provider") {
		t.Fatalf("message IDs = %q / %q / %q, err = %v", first, second, other, err)
	}
	if _, err := codec.EncodeMessageKey(""); err == nil {
		t.Fatal("empty provider key must be rejected")
	}
}

func TestCodecSeparatesOpaqueEventCallAndApprovalIDs(t *testing.T) {
	t.Parallel()
	codec, _ := New([]byte("0123456789abcdef0123456789abcdef"))
	eventID, _ := codec.EncodeEventKey("same-provider-key")
	callID, _ := codec.EncodeCallKey("same-provider-key")
	approvalID, _ := codec.EncodeApprovalKey("same-provider-key")
	for prefix, id := range map[string]domain.ID{"evt_": eventID, "call_": callID, "apr_": approvalID} {
		if !strings.HasPrefix(string(id), prefix) || !id.Valid() {
			t.Fatalf("%s ID = %q", prefix, id)
		}
	}
	if eventID == callID || callID == approvalID || eventID == approvalID {
		t.Fatalf("opaque namespaces collided: %q, %q, %q", eventID, callID, approvalID)
	}
}

func TestDecodeKeyAcceptsOnlyExactKeyMaterial(t *testing.T) {
	t.Parallel()
	if key, err := DecodeKey([]byte("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY")); err != nil || len(key) != 32 {
		t.Fatalf("key = %x, err = %v", key, err)
	}
	if _, err := DecodeKey([]byte("short")); err == nil {
		t.Fatal("short key must be rejected")
	}
}
