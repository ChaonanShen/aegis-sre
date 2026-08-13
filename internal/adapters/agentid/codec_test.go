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

func TestDecodeKeyAcceptsOnlyExactKeyMaterial(t *testing.T) {
	t.Parallel()
	if key, err := DecodeKey([]byte("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY")); err != nil || len(key) != 32 {
		t.Fatalf("key = %x, err = %v", key, err)
	}
	if _, err := DecodeKey([]byte("short")); err == nil {
		t.Fatal("short key must be rejected")
	}
}
