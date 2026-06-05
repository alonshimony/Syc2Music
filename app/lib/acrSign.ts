// ACRCloud request signing. Kept dependency-free and pure so it can be unit-tested
// against a known vector. The signature string concatenates the request components
// with newline separators, then HMAC-SHA1 with the access secret, base64-encoded.

export interface AcrSignParts {
  httpMethod: string;
  httpUri: string;
  accessKey: string;
  dataType: string;
  signatureVersion: string;
  timestamp: string;
}

/** Minimal subset of Node's `crypto` we depend on (injected for testability). */
export interface HmacProvider {
  createHmac(
    algorithm: string,
    key: string
  ): { update(data: string): { digest(encoding: "base64"): string } };
}

export function buildAcrStringToSign(parts: AcrSignParts): string {
  return [
    parts.httpMethod,
    parts.httpUri,
    parts.accessKey,
    parts.dataType,
    parts.signatureVersion,
    parts.timestamp,
  ].join("\n");
}

export function buildAcrSignature(
  parts: AcrSignParts,
  accessSecret: string,
  hmac: HmacProvider
): string {
  const stringToSign = buildAcrStringToSign(parts);
  return hmac.createHmac("sha1", accessSecret).update(stringToSign).digest("base64");
}
