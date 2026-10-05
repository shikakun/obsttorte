const HEX = "0123456789abcdef";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function isSha256(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

export function toHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) {
    output += HEX[(byte >> 4) & 0xf] + HEX[byte & 0xf];
  }
  return output;
}

export async function sha256Hex(data: string | BufferSource): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}
