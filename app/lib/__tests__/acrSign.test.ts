import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { buildAcrStringToSign, buildAcrSignature } from "../acrSign";

const parts = {
  httpMethod: "POST",
  httpUri: "/v1/identify",
  accessKey: "test_access_key",
  dataType: "audio",
  signatureVersion: "1",
  timestamp: "1700000000",
};

describe("buildAcrStringToSign", () => {
  it("joins the components with newlines in the documented order", () => {
    expect(buildAcrStringToSign(parts)).toBe(
      "POST\n/v1/identify\ntest_access_key\naudio\n1\n1700000000"
    );
  });
});

describe("buildAcrSignature", () => {
  it("matches a direct HMAC-SHA1/base64 of the string-to-sign", () => {
    const secret = "test_access_secret";
    const expected = crypto
      .createHmac("sha1", secret)
      .update(buildAcrStringToSign(parts))
      .digest("base64");

    expect(buildAcrSignature(parts, secret, crypto)).toBe(expected);
  });

  it("is a known fixed vector for a stable input", () => {
    // Regression guard: locks the exact signature for these inputs.
    expect(buildAcrSignature(parts, "test_access_secret", crypto)).toBe(
      "xwvNQha1a/XfBw69Lbh8HKwitms="
    );
  });
});
