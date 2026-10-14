import { createHash } from "node:crypto";
import { WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS } from "@zcode/shared";
import { describe, expect, it } from "vitest";

describe("relay auth primitives", () => {
  it("proof 与桌面端算法逐位一致（AUTH_PROOF_VECTORS 的 device / terminal 两条向量全部命中）", async () => {
    const { calculateRelayProof } = await import("../src/relay/relayAuth.js");

    const deviceVector = WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS.find(
      (vector) => vector.role === "device",
    );
    const terminalVector = WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS.find(
      (vector) => vector.role === "terminal",
    );
    expect(deviceVector).toBeDefined();
    expect(terminalVector).toBeDefined();
    if (!deviceVector || !terminalVector) {
      return;
    }

    expect(
      calculateRelayProof(
        deviceVector.passHash,
        deviceVector.nonce,
        deviceVector.role,
        deviceVector.deviceSid,
      ),
    ).toBe(deviceVector.proof);
    expect(
      calculateRelayProof(
        terminalVector.passHash,
        terminalVector.nonce,
        terminalVector.role,
        terminalVector.deviceSid,
      ),
    ).toBe(terminalVector.proof);
  });

  it("nonce / role / device_sid 任一不符都不产生相同 proof", async () => {
    const { calculateRelayProof } = await import("../src/relay/relayAuth.js");
    const [vector] = WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS;
    expect(vector).toBeDefined();
    if (!vector) {
      return;
    }

    expect(calculateRelayProof(vector.passHash, "nonce-2", vector.role, vector.deviceSid)).not.toBe(
      vector.proof,
    );
    expect(
      calculateRelayProof(
        vector.passHash,
        vector.nonce,
        vector.role === "device" ? "terminal" : "device",
        vector.deviceSid,
      ),
    ).not.toBe(vector.proof);
    expect(calculateRelayProof(vector.passHash, vector.nonce, vector.role, "device-2")).not.toBe(
      vector.proof,
    );
    // pass_hash 是 HMAC key：换 key 也必须换 proof，否则任意二维码都能配对。
    expect(
      calculateRelayProof("b3RoZXJfaGFzaA", vector.nonce, vector.role, vector.deviceSid),
    ).not.toBe(vector.proof);
  });

  it("password 是 24 随机字节 base64url，pass_hash 是 base64(sha256(password))", async () => {
    const { createRelayPassword, createRelayPassHash } = await import("../src/relay/relayAuth.js");

    const password = createRelayPassword();
    expect(Buffer.from(password, "base64url")).toHaveLength(24);
    expect(createRelayPassHash(password)).toBe(
      createHash("sha256").update(password).digest("base64"),
    );
  });
});
