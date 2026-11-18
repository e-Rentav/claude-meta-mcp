import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSecretsFromSsm, type GetParametersByPathFn } from "../src/lib/ssm-secrets.js";

const PATH = "/erentav/meta-mcp";

function fakeSsm(pages: Array<{ Parameters: Array<{ Name: string; Value: string }>; NextToken?: string }>) {
  const calls: Array<Parameters<GetParametersByPathFn>[0]> = [];
  const fn: GetParametersByPathFn = async (input) => {
    calls.push(input);
    const idx = input.NextToken ? Number(input.NextToken) : 0;
    return pages[idx];
  };
  return { fn, calls };
}

test("reads both secrets with decryption, across pages, ignoring other parameters", async () => {
  const { fn, calls } = fakeSsm([
    { Parameters: [{ Name: `${PATH}/AUTH_TOKEN`, Value: "auth-value" }, { Name: `${PATH}/OTHER`, Value: "x" }], NextToken: "1" },
    { Parameters: [{ Name: `${PATH}/META_ACCESS_TOKEN`, Value: "meta-value" }] },
  ]);
  const secrets = await loadSecretsFromSsm(fn, PATH);
  assert.deepEqual(secrets, { META_ACCESS_TOKEN: "meta-value", AUTH_TOKEN: "auth-value" });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.WithDecryption === true && c.Recursive === false && c.Path === PATH));
});

test("a missing secret fails with its name and never with any value", async () => {
  const { fn } = fakeSsm([{ Parameters: [{ Name: `${PATH}/AUTH_TOKEN`, Value: "super-secret-value" }] }]);
  await assert.rejects(loadSecretsFromSsm(fn, PATH), (err: Error) => {
    assert.match(err.message, /META_ACCESS_TOKEN/);
    assert.doesNotMatch(err.message, /super-secret-value/);
    return true;
  });
});

test("parameters from a sibling path with the same prefix are not picked up", async () => {
  const { fn } = fakeSsm([
    {
      Parameters: [
        { Name: `${PATH}/AUTH_TOKEN`, Value: "a" },
        { Name: `${PATH}-old/META_ACCESS_TOKEN`, Value: "wrong" },
      ],
    },
  ]);
  await assert.rejects(loadSecretsFromSsm(fn, PATH), /META_ACCESS_TOKEN/);
});

test("rejects malformed paths", async () => {
  const { fn } = fakeSsm([{ Parameters: [] }]);
  await assert.rejects(loadSecretsFromSsm(fn, "erentav/meta-mcp"), /SSM_PARAMETER_PATH/);
  await assert.rejects(loadSecretsFromSsm(fn, "/erentav/meta-mcp/"), /SSM_PARAMETER_PATH/);
});
