/**
 * Load the connector's secrets from SSM Parameter Store (SecureString).
 *
 * Only the names in SECRET_NAMES are read into the environment; anything else
 * under the path is ignored. Values are never logged or put in error messages.
 */

export const SECRET_NAMES = ["META_ACCESS_TOKEN", "AUTH_TOKEN"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

interface SsmParameter {
  Name?: string;
  Value?: string;
}

interface SsmPage {
  Parameters?: SsmParameter[];
  NextToken?: string;
}

/** Minimal surface of the AWS SDK SSM client, so tests can pass a fake. */
export type GetParametersByPathFn = (input: {
  Path: string;
  WithDecryption: boolean;
  Recursive: boolean;
  NextToken?: string;
}) => Promise<SsmPage>;

export async function loadSecretsFromSsm(
  getParametersByPath: GetParametersByPathFn,
  path: string
): Promise<Record<SecretName, string>> {
  if (!/^\/[A-Za-z0-9_.\-/]+$/.test(path) || path.endsWith("/")) {
    throw new Error(`SSM_PARAMETER_PATH must look like /a/b (no trailing slash), got "${path}"`);
  }
  const found = new Map<string, string>();
  let nextToken: string | undefined;
  do {
    const page = await getParametersByPath({ Path: path, WithDecryption: true, Recursive: false, NextToken: nextToken });
    for (const p of page.Parameters ?? []) {
      if (!p.Name || !p.Name.startsWith(`${path}/`) || !p.Value) continue;
      const name = p.Name.slice(path.length + 1);
      if ((SECRET_NAMES as readonly string[]).includes(name)) found.set(name, p.Value);
    }
    nextToken = page.NextToken;
  } while (nextToken);

  const missing = SECRET_NAMES.filter((n) => !found.has(n));
  if (missing.length > 0) {
    throw new Error(`Missing SSM parameters under ${path}: ${missing.join(", ")}`);
  }
  return Object.fromEntries(SECRET_NAMES.map((n) => [n, found.get(n)!])) as Record<SecretName, string>;
}
