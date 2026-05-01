import { randomBytes, createCipheriv, createDecipheriv, createHash } from "crypto";
import { config } from "../config";

const ALGORITHM = "aes-256-gcm";
const KEY = Buffer.from(config.TOKEN_ENCRYPTION_KEY, "hex"); // 32 bytes

/**
 * Encrypt a plaintext string. Returns "<iv_b64>:<authTag_b64>:<cipher_b64>".
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(":");
}

/**
 * Decrypt a string produced by encrypt().
 */
export function decrypt(ciphertext: string): string {
  const [ivB64, authTagB64, encB64] = ciphertext.split(":");
  if (!ivB64 || !authTagB64 || !encB64) throw new Error("Invalid ciphertext format");
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const encrypted = Buffer.from(encB64, "base64");
  const decipher = createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

/** SHA-256 hex digest — used for API key and refresh token storage */
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Cryptographically random hex string of given byte length */
export function randomHex(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}
