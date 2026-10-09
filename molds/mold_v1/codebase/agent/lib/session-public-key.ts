/**
 * The PUBLIC half of the key the web app signs its own tokens with (lib/auth-session.ts), as a PEM, or null. Read as
 * PEM or base64-of-PEM, like the web side. The private key is never deployed to the agent.
 */
export function sessionPublicKeyPem(raw: string | undefined = process.env.AUTH_JWT_PUBLIC_KEY): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (value.includes("-----BEGIN")) return value.replace(/\\n/g, "\n");
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    return decoded.includes("-----BEGIN") ? decoded : null;
  } catch {
    return null;
  }
}
