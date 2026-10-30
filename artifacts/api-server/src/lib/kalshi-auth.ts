import { constants, createPrivateKey, sign, type KeyObject } from "node:crypto";

/** Keys stay server-side. Never include a key, signature or request headers in logs. */
export class KalshiAuth {
  private readonly key: KeyObject;
  constructor(private readonly keyId: string, pem: string) {
    if (!keyId || !pem) throw new Error("Faltan las credenciales de Kalshi WebSocket.");
    try {
      // Secret forms can flatten PEM lines or preserve literal \r\n escapes.
      // Rewrap only a complete, matching private-key block with a base64 body.
      const text = pem.trim().replace(/^(['"])([\s\S]*)\1$/, "$2")
        .replace(/\\r/g, "\r").replace(/\\n/g, "\n").trim();
      const block = text.match(/^-----BEGIN ((?:RSA )?PRIVATE KEY)-----([\s\S]*?)-----END \1-----$/);
      if (!block) throw new Error("Invalid PEM block");
      const body = block[2].replace(/\s/g, "");
      if (!/^[A-Za-z0-9+/=]+$/.test(body)) throw new Error("Invalid PEM body");
      const normalized = `-----BEGIN ${block[1]}-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END ${block[1]}-----\n`;
      this.key = createPrivateKey(normalized);
    } catch {
      throw new Error("La clave privada de Kalshi no es un PEM válido.");
    }
    if (!["rsa", "ed25519"].includes(this.key.asymmetricKeyType ?? "")) {
      throw new Error("Kalshi requiere una clave RSA o Ed25519.");
    }
  }

  headers(path: string, timestamp = Date.now()): Record<string, string> {
    const time = String(timestamp);
    const message = Buffer.from(`${time}GET${path.split("?")[0]}`);
    const signature = this.key.asymmetricKeyType === "ed25519"
      ? sign(null, message, this.key)
      : sign("sha256", message, {
        key: this.key, padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
      });
    return {
      "KALSHI-ACCESS-KEY": this.keyId,
      "KALSHI-ACCESS-TIMESTAMP": time,
      "KALSHI-ACCESS-SIGNATURE": signature.toString("base64"),
    };
  }
}

export { KalshiReadPacer } from "./kalshi-read-scheduler";
