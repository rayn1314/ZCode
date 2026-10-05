import assert from "node:assert/strict";
import test from "node:test";
import {
  expandAllowedEnvVars,
  resolveHttpRequest,
} from "../src/hooks/configured-runner-callback.js";

/**
 * http hook 安全模型（spec §10.1）：
 * - SSRF 防护：回环 / 链路本地始终拒绝，私网默认拒绝、allowPrivateNetwork 放行；
 * - 凭据处理：$ENV_VAR 只展开 allowedEnvVars 白名单。
 */

test("resolveHttpRequest rejects loopback addresses", async () => {
  await assert.rejects(
    resolveHttpRequest("http://127.0.0.1/", false),
    /private\/loopback/,
  );
  await assert.rejects(
    resolveHttpRequest("http://[::1]/", false),
    /private\/loopback/,
  );
});

test("resolveHttpRequest rejects link-local metadata address", async () => {
  await assert.rejects(
    resolveHttpRequest("http://169.254.169.254/latest/meta-data/", false),
    /private\/loopback/,
  );
  await assert.rejects(
    resolveHttpRequest("http://169.254.169.254/latest/meta-data/", true),
    /private\/loopback/,
  );
});

test("resolveHttpRequest rejects private networks by default", async () => {
  await assert.rejects(resolveHttpRequest("http://10.0.0.1/", false), /private\/loopback/);
  await assert.rejects(resolveHttpRequest("http://172.16.0.1/", false), /private\/loopback/);
  await assert.rejects(resolveHttpRequest("http://192.168.1.1/", false), /private\/loopback/);
});

test("resolveHttpRequest allows private networks when allowPrivateNetwork is true", async () => {
  const url = await resolveHttpRequest("http://10.0.0.1/", true);
  assert.equal(url.hostname, "10.0.0.1");
  const url172 = await resolveHttpRequest("http://172.16.0.1/", true);
  assert.equal(url172.hostname, "172.16.0.1");
  const url192 = await resolveHttpRequest("http://192.168.1.1/", true);
  assert.equal(url192.hostname, "192.168.1.1");
});

test("resolveHttpRequest allows public addresses", async () => {
  const url = await resolveHttpRequest("http://8.8.8.8/", false);
  assert.equal(url.hostname, "8.8.8.8");
});

test("resolveHttpRequest rejects non-http(s) protocols", async () => {
  await assert.rejects(resolveHttpRequest("ftp://example.com/", false), /http or https/);
  await assert.rejects(resolveHttpRequest("file:///etc/passwd", false), /http or https/);
});

test("expandAllowedEnvVars expands only whitelisted variables", () => {
  process.env.HOOK_TEST_ALLOWED = "allowed-value";
  process.env.HOOK_TEST_FORBIDDEN = "forbidden-value";
  try {
    assert.equal(
      expandAllowedEnvVars("$HOOK_TEST_ALLOWED", ["HOOK_TEST_ALLOWED"]),
      "allowed-value",
    );
    assert.equal(
      expandAllowedEnvVars("$HOOK_TEST_FORBIDDEN", ["HOOK_TEST_ALLOWED"]),
      "$HOOK_TEST_FORBIDDEN",
    );
    assert.equal(
      expandAllowedEnvVars("a $HOOK_TEST_ALLOWED b $HOOK_TEST_FORBIDDEN", [
        "HOOK_TEST_ALLOWED",
      ]),
      "a allowed-value b $HOOK_TEST_FORBIDDEN",
    );
  } finally {
    delete process.env.HOOK_TEST_ALLOWED;
    delete process.env.HOOK_TEST_FORBIDDEN;
  }
});

test("expandAllowedEnvVars does not expand when whitelist is empty", () => {
  process.env.HOOK_TEST_EMPTY = "value";
  try {
    assert.equal(expandAllowedEnvVars("$HOOK_TEST_EMPTY", undefined), "$HOOK_TEST_EMPTY");
    assert.equal(expandAllowedEnvVars("$HOOK_TEST_EMPTY", []), "$HOOK_TEST_EMPTY");
  } finally {
    delete process.env.HOOK_TEST_EMPTY;
  }
});