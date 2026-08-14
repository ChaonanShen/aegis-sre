package agentid

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
)

// Codec 将 Codex UUIDv7 转换为稳定、不可读且可逆的公开 Session ID。
// nonce 由密钥和 UUID 派生；UUID 本身具有高熵，因此同一密钥下可安全获得确定性密文。
type Codec struct {
	aead cipher.AEAD
	key  []byte
}

func New(key []byte) (*Codec, error) {
	if len(key) != 32 {
		return nil, errors.New("agent ID key must contain exactly 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Codec{aead: aead, key: append([]byte(nil), key...)}, nil
}

func DecodeKey(value []byte) ([]byte, error) {
	trimmed := strings.TrimSpace(string(value))
	if decoded, err := base64.RawURLEncoding.DecodeString(trimmed); err == nil && len(decoded) == 32 {
		return decoded, nil
	}
	if len(value) == 32 {
		return append([]byte(nil), value...), nil
	}
	return nil, errors.New("agent ID key must be 32 raw bytes or base64url without padding")
}

func (codec *Codec) EncodeUUID(value string) (domain.ID, error) {
	return codec.encodeUUID(value, "ses_", "aegis-agent-session-v1")
}

func (codec *Codec) EncodeTurnUUID(value string) (domain.ID, error) {
	return codec.encodeUUID(value, "turn_", "aegis-agent-turn-v1")
}

func (codec *Codec) encodeUUID(value, prefix, purpose string) (domain.ID, error) {
	raw, err := parseUUID(value)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, codec.key)
	_, _ = mac.Write([]byte(purpose))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write(raw)
	nonce := mac.Sum(nil)[:codec.aead.NonceSize()]
	sealed := codec.aead.Seal(nil, nonce, raw, []byte(purpose))
	token := append(append([]byte(nil), nonce...), sealed...)
	id := domain.ID(prefix + base64.RawURLEncoding.EncodeToString(token))
	if !id.Valid() {
		return "", errors.New("encoded session ID does not satisfy the public contract")
	}
	return id, nil
}

func (codec *Codec) DecodeUUID(id domain.ID) (string, error) {
	return codec.decodeUUID(id, "ses_", "aegis-agent-session-v1")
}

func (codec *Codec) DecodeTurnUUID(id domain.ID) (string, error) {
	return codec.decodeUUID(id, "turn_", "aegis-agent-turn-v1")
}

func (codec *Codec) decodeUUID(id domain.ID, prefix, purpose string) (string, error) {
	if !id.Valid() || !strings.HasPrefix(string(id), prefix) {
		return "", errors.New("invalid public agent ID")
	}
	token, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(string(id), prefix))
	if err != nil || len(token) <= codec.aead.NonceSize() {
		return "", errors.New("invalid public agent ID")
	}
	nonce := token[:codec.aead.NonceSize()]
	plain, err := codec.aead.Open(nil, nonce, token[codec.aead.NonceSize():], []byte(purpose))
	if err != nil || len(plain) != 16 {
		return "", errors.New("invalid public agent ID")
	}
	return formatUUID(plain), nil
}

func parseUUID(value string) ([]byte, error) {
	compact := strings.ReplaceAll(value, "-", "")
	if len(value) != 36 || len(compact) != 32 {
		return nil, errors.New("Codex thread ID must be a UUID")
	}
	raw, err := hex.DecodeString(compact)
	if err != nil || len(raw) != 16 {
		return nil, errors.New("Codex thread ID must be a UUID")
	}
	return raw, nil
}

func formatUUID(raw []byte) string {
	encoded := hex.EncodeToString(raw)
	return encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:]
}
