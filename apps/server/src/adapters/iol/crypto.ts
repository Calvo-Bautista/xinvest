/**
 * Cifrado simétrico (AES-256-GCM, WebCrypto) para guardar los tokens de IOL en la DB.
 * La clave se deriva con SHA-256 de un secreto de entorno; si la DB se filtra, los tokens no.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

async function keyFrom(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`xinvest:iol:${secret}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

export async function encryptJson(secret: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await keyFrom(secret),
    enc.encode(JSON.stringify(value)),
  );
  return `v1.${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

/** Devuelve null si no se puede descifrar (p. ej. cambió el secreto): se fuerza re-login. */
export async function decryptJson<T>(secret: string, payload: string): Promise<T | null> {
  const [v, iv, ct] = payload.split('.');
  if (v !== 'v1' || !iv || !ct) return null;
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(iv) },
      await keyFrom(secret),
      unb64(ct),
    );
    return JSON.parse(dec.decode(pt)) as T;
  } catch {
    return null;
  }
}
