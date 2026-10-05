const DEVICE_TOKEN_PREFIX = "obsttorte_";
const DEVICE_TOKEN_BYTES = 32;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function toBase32Lower(bytes: Uint8Array): string {
  let bitCount = 0;
  let buffer = 0;
  let output = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bitCount - 5)) & 31];
      bitCount -= 5;
    }
  }
  if (bitCount > 0) output += BASE32_ALPHABET[(buffer << (5 - bitCount)) & 31];
  return output;
}

export function generateDeviceToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(DEVICE_TOKEN_BYTES));
  return `${DEVICE_TOKEN_PREFIX}${toBase32Lower(bytes)}`;
}
