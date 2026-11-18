/**
 * Entrypoint on AWS (Lambda + Web Adapter, or EC2): read the secrets from SSM
 * Parameter Store into process.env, then start the normal server.
 *
 * config.ts reads process.env when it is first imported, so index.js must be
 * imported only after the secrets are in place.
 */

import { GetParametersByPathCommand, SSMClient } from "@aws-sdk/client-ssm";
import { loadSecretsFromSsm } from "./lib/ssm-secrets.js";

async function start(): Promise<void> {
  const path = process.env.SSM_PARAMETER_PATH;
  if (!path) throw new Error("SSM_PARAMETER_PATH is not set");

  const ssm = new SSMClient({});
  const secrets = await loadSecretsFromSsm((input) => ssm.send(new GetParametersByPathCommand(input)), path);
  for (const [name, value] of Object.entries(secrets)) process.env[name] = value;
  ssm.destroy();

  await import("./index.js");
}

start().catch((err: unknown) => {
  // Message only: never print the error object (it could carry request data).
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      msg: "aws bootstrap failed",
      error: err instanceof Error ? err.message : String(err),
    })
  );
  process.exit(1);
});
