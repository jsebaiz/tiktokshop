export function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  return base64ToBytes(padded);
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

export function safeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hmacSign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64UrlEncode(new Uint8Array(signature));
}

export function encryptionReady(keyB64: string | undefined): boolean {
  if (!keyB64) return false;
  try {
    return base64ToBytes(keyB64).length === 32;
  } catch {
    return false;
  }
}

export async function encryptString(keyB64: string, plaintext: string): Promise<string> {
  const raw = base64ToBytes(keyB64);
  if (raw.length !== 32) throw new Error("encryption_key");
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const packed = new Uint8Array(iv.length + cipher.length);
  packed.set(iv, 0);
  packed.set(cipher, iv.length);
  return `v1:${bytesToBase64(packed)}`;
}

export async function decryptString(keyB64: string, packed: string): Promise<string | null> {
  try {
    if (!packed.startsWith("v1:")) return null;
    const raw = base64ToBytes(keyB64);
    if (raw.length !== 32) return null;
    const data = base64ToBytes(packed.slice(3));
    if (data.length < 13) return null;
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: data.slice(0, 12) },
      key,
      data.slice(12),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

export function sanitizeMessage(input: string, max = 300): string {
  let text = input.replace(/bearer\s+\S+/gi, "bearer [redacted]");
  text = text.replace(/ya29\.[0-9A-Za-z_-]+/g, "[redacted]");
  text = text.replace(/crsr_[0-9A-Za-z_-]+/g, "[redacted]");
  text = text.replace(/upload_id=[^&\s]+/gi, "upload_id=[redacted]");
  text = text.replace(/[\u0000-\u001f]/g, " ");
  if (text.length > max) text = text.slice(0, max);
  return text;
}
