package domain

import "testing"

func TestBusinessIDValidation(t *testing.T) {
	for value, valid := range map[ID]bool{
		"ses_0123456789": true,
		"provider-id":    false,
		"":               false,
	} {
		if value.Valid() != valid {
			t.Fatalf("ID(%q).Valid() = %v, want %v", value, value.Valid(), valid)
		}
	}
}

func TestActorRequiresStableIdentity(t *testing.T) {
	if err := (ActorContext{TenantID: "tenant", OrgID: "org", UserID: "user"}).Validate(); err != nil {
		t.Fatalf("valid actor rejected: %v", err)
	}
	if err := (ActorContext{TenantID: "tenant"}).Validate(); err == nil {
		t.Fatal("incomplete actor accepted")
	}
}
