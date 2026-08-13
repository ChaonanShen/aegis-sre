type ClientTurnCrypto = Pick<Crypto, 'getRandomValues'> & Partial<Pick<Crypto, 'randomUUID'>>;

/**
 * 生成符合 RFC 4122 v4 格式的 client_turn_id。
 *
 * 公网 HTTP 不属于安全上下文，浏览器不会暴露 crypto.randomUUID()；
 * getRandomValues() 在该场景仍可使用，因此保留它作为临时 HTTP 部署的兼容路径。
 */
export function newClientTurnId(cryptoAPI: ClientTurnCrypto = globalThis.crypto): string {
  if (typeof cryptoAPI.randomUUID === 'function') {
    return cryptoAPI.randomUUID();
  }

  const bytes = cryptoAPI.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));

  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex
    .slice(8, 10)
    .join('')}-${hex.slice(10).join('')}`;
}
