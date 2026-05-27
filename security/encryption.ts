import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 12 bytes for GCM

// Derives a secure 32-byte key from any input string using SHA-256
function deriveKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret).digest();
}

/**
 * Encrypts plaintext using AES-256-GCM.
 * Output format: iv_hex:ciphertext_hex:auth_tag_hex
 */
export function encrypt(plaintext: string, secret: string): string {
  if (!secret) {
    throw new Error("Encryption key is required");
  }

  const key = deriveKey(secret);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag().toString("hex");

  return `${iv.toString("hex")}:${encrypted}:${authTag}`;
}

/**
 * Decrypts ciphertext using AES-256-GCM.
 * Input format: iv_hex:ciphertext_hex:auth_tag_hex
 */
export function decrypt(ciphertext: string, secret: string): string {
  if (!secret) {
    throw new Error("Decryption key is required");
  }

  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted format. Expected iv:ciphertext:tag");
  }

  const [ivHex, encryptedHex, authTagHex] = parts;
  const key = deriveKey(secret);
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}
