#!/usr/bin/env python3
"""
Guard run in CI before every deploy: template.yaml must stay inside what the
deploy role (erentav-meta-mcp-deploy) was built and checked for.

Same rules as the pre-flight in infra/fase1-iam-cloudshell.sh:
  * Lambda packaged as .zip (no PackageType: Image / ImageUri / ImageConfig):
    the deploy role has no ECR permissions on purpose.
  * Only the 5 resource types whose handler permissions were checked.
  * No SAM properties that generate extra, unchecked resources.

If a change needs any of these, update the policy with the CloudShell script
first (its pre-flight re-checks the handlers), then relax this guard.
"""
import re
import sys

CHECKED_TYPES = {
    "AWS::S3::Bucket",
    "AWS::Lambda::Function",
    "AWS::Lambda::Url",
    "AWS::Lambda::Permission",
    "AWS::Logs::LogGroup",
}
IMAGE_MARKERS = {
    "PackageType: Image": r'^\s*"?PackageType"?\s*:\s*["\']?Image\b',
    "ImageUri": r'^\s*"?ImageUri"?\s*:',
    "ImageConfig": r'^\s*"?ImageConfig"?\s*:',
}
SAM_EXTRA_KEYS = ("AutoPublishAlias", "DeploymentPreference", "EventInvokeConfig", "ProvisionedConcurrencyConfig", "Events")


def check(text: str) -> list[str]:
    problems = []
    if not re.search(r"^Resources\s*:", text, re.M):
        problems.append("no top-level 'Resources:' found")
    for name, rx in IMAGE_MARKERS.items():
        if re.search(rx, text, re.M):
            problems.append(f"{name}: container-image Lambda needs ECR permissions the deploy role does not have")
    declared = set(re.findall(r'^\s*"?Type"?\s*:\s*["\']?(AWS::[A-Za-z0-9]+::[A-Za-z0-9]+)', text, re.M))
    declared = {"AWS::Lambda::Function" if t == "AWS::Serverless::Function" else t for t in declared}
    for t in sorted(declared - CHECKED_TYPES):
        problems.append(f"resource type {t} is not covered by the deploy role's checked handlers")
    for key in SAM_EXTRA_KEYS:
        if re.search(rf'^\s*"?{key}"?\s*:', text, re.M):
            problems.append(f"{key} makes SAM generate resources the deploy role was not checked for")
    return problems


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else "template.yaml"
    problems = check(open(path, encoding="utf-8").read())
    if problems:
        print(f"{path}: template guard FAILED", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        print("Update the IAM policy with infra/fase1-iam-cloudshell.sh (pre-flight) before changing this guard.", file=sys.stderr)
        return 1
    print(f"{path}: template guard OK (.zip, {len(CHECKED_TYPES)} checked types, no extra SAM resources)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
