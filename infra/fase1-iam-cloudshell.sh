#!/usr/bin/env bash
# =============================================================================
# e-Rentav · claude-meta-mcp · Fase 1 — recursos IAM (rev. 3)
# Rodar no AWS CloudShell com credencial de ADMIN, região us-east-2.
#
# Ordem:
#   0a. Mostra a concorrência da conta (só leitura) — cole a saída no chat.
#   0b. PRÉ-VOO: baixa com `describe-type` as permissões dos handlers
#       create/read/update/delete dos 5 tipos do template e confere contra a
#       policy de deploy. Se faltar alguma ação fora da lista de exclusões
#       justificadas, o script PARA antes de criar qualquer coisa.
#   1.  Provedor OIDC do GitHub (só se ainda não existir)
#   2.  Role de execução da Lambda ......... erentav-meta-mcp-lambda
#   3.  Role de deploy do GitHub Actions .... erentav-meta-mcp-deploy
#       (só assumível pelo environment "aws-prod" do repo e-Rentav/claude-meta-mcp)
#   4.  Bucket de artefatos do SAM .......... erentav-meta-mcp-artifacts-010928221211
#
# Não cria: a stack, a Lambda, o bucket de mídias, os parâmetros SSM.
# Pode ser rodado de novo: pula o que já existe e reaplica as policies.
#
# Uso:
#   bash fase1-iam-cloudshell.sh --template ~/template.yaml --check-only   (só o pré-voo)
#   bash fase1-iam-cloudshell.sh --template ~/template.yaml                (pré-voo + criação)
# --template aceita um arquivo local ou uma URL https do template SAM. Sem ele,
# o pré-voo não sabe o tipo de pacote da Lambda e exige também as ações de
# imagem de contêiner (falha fechada). No CloudShell: Actions → Upload file.
# =============================================================================
set -euo pipefail

CHECK_ONLY="false"
TEMPLATE_SRC=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check-only) CHECK_ONLY="true"; shift ;;
    --template) TEMPLATE_SRC="${2:-}"; shift 2 ;;
    *) echo "ERRO: argumento desconhecido: $1" >&2; exit 2 ;;
  esac
done

ACCOUNT_ID="010928221211"
REGION="us-east-2"
APP="erentav-meta-mcp"
GITHUB_REPO="e-Rentav/claude-meta-mcp"
GITHUB_REPO_LOWER="e-rentav/claude-meta-mcp"
GITHUB_ENVIRONMENT="aws-prod"

EXEC_ROLE="${APP}-lambda"
DEPLOY_ROLE="${APP}-deploy"
FUNCTION_NAME="${APP}"
STACK_NAME="${APP}"
MEDIA_BUCKET="${APP}-media-${ACCOUNT_ID}"
ARTIFACTS_BUCKET="${APP}-artifacts-${ACCOUNT_ID}"
SSM_PATH="/erentav/meta-mcp"
LOG_GROUP="/aws/lambda/${FUNCTION_NAME}"
OIDC_HOST="token.actions.githubusercontent.com"
OIDC_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_HOST}"
# Camada oficial do AWS Lambda Web Adapter (conta 753240598075).
LWA_LAYER_ARN_PREFIX="arn:aws:lambda:${REGION}:753240598075:layer:LambdaAdapterLayerArm64"
TAGS='Key=Project,Value=erentav-meta-mcp Key=ManagedBy,Value=cloudshell-fase1'
TEMPLATE_TYPES=("AWS::S3::Bucket" "AWS::Lambda::Function" "AWS::Lambda::Url" "AWS::Lambda::Permission" "AWS::Logs::LogGroup")

export AWS_DEFAULT_REGION="${REGION}"

CURRENT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
if [[ "${CURRENT_ACCOUNT}" != "${ACCOUNT_ID}" ]]; then
  echo "ERRO: conta atual é ${CURRENT_ACCOUNT}, esperado ${ACCOUNT_ID}." >&2
  exit 1
fi
echo "Conta ${CURRENT_ACCOUNT}, região ${REGION}, identidade: $(aws sts get-caller-identity --query Arn --output text)"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

# --- Documentos de policy ----------------------------------------------------
cat > "${WORKDIR}/exec-trust.json" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
JSON

cat > "${WORKDIR}/exec-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "WriteOwnLogs",
      "Effect": "Allow",
      "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:${LOG_GROUP}:*"
    },
    {
      "Sid": "ReadOwnSecrets",
      "Effect": "Allow",
      "Action": ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"],
      "Resource": [
        "arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter${SSM_PATH}",
        "arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter${SSM_PATH}/*"
      ]
    },
    {
      "Sid": "DecryptSecureStringViaSsmOnly",
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "*",
      "Condition": { "StringEquals": { "kms:ViaService": "ssm.${REGION}.amazonaws.com" } }
    },
    {
      "Sid": "ReadMediaInbox",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::${MEDIA_BUCKET}/inbox/*"
    },
    {
      "Sid": "ListMediaInbox",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::${MEDIA_BUCKET}",
      "Condition": { "StringLike": { "s3:prefix": ["inbox/", "inbox/*"] } }
    }
  ]
}
JSON

# O "sub" do token OIDC do GitHub traz o dono/repo como o GitHub grafa; as duas
# grafias abaixo são o MESMO repositório (nomes do GitHub não diferenciam caixa).
cat > "${WORKDIR}/deploy-trust.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "${OIDC_ARN}" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_HOST}:aud": "sts.amazonaws.com",
          "${OIDC_HOST}:sub": [
            "repo:${GITHUB_REPO}:environment:${GITHUB_ENVIRONMENT}",
            "repo:${GITHUB_REPO_LOWER}:environment:${GITHUB_ENVIRONMENT}"
          ]
        }
      }
    }
  ]
}
JSON

# Policy de deploy. Base: permissões dos handlers create/read/update/delete dos
# 5 tipos do template (conferidas no pré-voo), cada uma presa ao recurso exato.
cat > "${WORKDIR}/deploy-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CfnManageOnlyThisStack",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateChangeSet", "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet", "cloudformation:DeleteChangeSet",
        "cloudformation:ListChangeSets", "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents", "cloudformation:DescribeStackResource",
        "cloudformation:DescribeStackResources", "cloudformation:ListStackResources",
        "cloudformation:GetTemplate", "cloudformation:DeleteStack"
      ],
      "Resource": "arn:aws:cloudformation:${REGION}:${ACCOUNT_ID}:stack/${STACK_NAME}/*"
    },
    {
      "Sid": "CfnUseSamTransform",
      "Effect": "Allow",
      "Action": "cloudformation:CreateChangeSet",
      "Resource": "arn:aws:cloudformation:${REGION}:aws:transform/Serverless-2016-10-31"
    },
    {
      "Sid": "CfnReadOnlyGlobal",
      "Effect": "Allow",
      "Action": ["cloudformation:ValidateTemplate", "cloudformation:GetTemplateSummary", "cloudformation:ListStacks"],
      "Resource": "*"
    },
    {
      "Sid": "SamArtifacts",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": ["arn:aws:s3:::${ARTIFACTS_BUCKET}", "arn:aws:s3:::${ARTIFACTS_BUCKET}/*"]
    },
    {
      "Sid": "LambdaFunctionUrlPermissionOnlyThisFunction",
      "Effect": "Allow",
      "Action": [
        "lambda:CreateFunction", "lambda:DeleteFunction", "lambda:GetFunction",
        "lambda:GetFunctionConfiguration", "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration", "lambda:PublishVersion",
        "lambda:ListVersionsByFunction", "lambda:ListTags", "lambda:TagResource",
        "lambda:UntagResource", "lambda:AssociateRuntimeAlias",
        "lambda:PutFunctionConcurrency", "lambda:DeleteFunctionConcurrency",
        "lambda:GetFunctionConcurrency",
        "lambda:GetFunctionCodeSigningConfig", "lambda:PutFunctionCodeSigningConfig",
        "lambda:DeleteFunctionCodeSigningConfig",
        "lambda:GetFunctionRecursionConfig", "lambda:PutFunctionRecursionConfig",
        "lambda:GetFunctionScalingConfig", "lambda:PutFunctionScalingConfig",
        "lambda:GetRuntimeManagementConfig", "lambda:PutRuntimeManagementConfig",
        "lambda:CreateFunctionUrlConfig", "lambda:GetFunctionUrlConfig",
        "lambda:UpdateFunctionUrlConfig", "lambda:DeleteFunctionUrlConfig",
        "lambda:AddPermission", "lambda:RemovePermission", "lambda:GetPolicy"
      ],
      "Resource": [
        "arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}",
        "arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}:*"
      ]
    },
    {
      "Sid": "LambdaUseWebAdapterLayer",
      "Effect": "Allow",
      "Action": "lambda:GetLayerVersion",
      "Resource": "${LWA_LAYER_ARN_PREFIX}:*"
    },
    {
      "Sid": "LambdaHandlerKmsOnlyViaLambda",
      "Effect": "Allow",
      "Action": ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey", "kms:CreateGrant", "kms:DescribeKey"],
      "Resource": "*",
      "Condition": { "StringEquals": { "kms:ViaService": "lambda.${REGION}.amazonaws.com" } }
    },
    {
      "Sid": "LambdaHandlerNetworkReadOnly",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeSecurityGroups", "ec2:DescribeSubnets", "ec2:DescribeVpcs",
        "ec2:DescribeNetworkInterfaces", "elasticfilesystem:DescribeMountTargets"
      ],
      "Resource": "*"
    },
    {
      "Sid": "PassOnlyTheExecRoleToLambda",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/${EXEC_ROLE}",
      "Condition": { "StringEquals": { "iam:PassedToService": "lambda.amazonaws.com" } }
    },
    {
      "Sid": "LogGroupOnlyThisOne",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup", "logs:DeleteLogGroup",
        "logs:PutRetentionPolicy", "logs:DeleteRetentionPolicy",
        "logs:TagResource", "logs:UntagResource", "logs:ListTagsForResource",
        "logs:TagLogGroup", "logs:UntagLogGroup",
        "logs:GetDataProtectionPolicy", "logs:PutDataProtectionPolicy", "logs:DeleteDataProtectionPolicy",
        "logs:PutIndexPolicy", "logs:DeleteIndexPolicy",
        "logs:PutResourcePolicy", "logs:DeleteResourcePolicy",
        "logs:AssociateKmsKey", "logs:DisassociateKmsKey",
        "logs:PutLogGroupDeletionProtection"
      ],
      "Resource": [
        "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:${LOG_GROUP}",
        "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:${LOG_GROUP}:*"
      ]
    },
    {
      "Sid": "LogsDescribeGlobal",
      "Effect": "Allow",
      "Action": ["logs:DescribeLogGroups", "logs:DescribeResourcePolicies", "logs:DescribeIndexPolicies"],
      "Resource": "*"
    },
    {
      "Sid": "MediaBucketOnlyThisOne",
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket", "s3:DeleteBucket", "s3:ListBucket", "s3:GetBucketLocation",
        "s3:GetBucketAcl", "s3:PutBucketAcl",
        "s3:TagResource", "s3:UntagResource", "s3:ListTagsForResource",
        "s3:GetBucketTagging", "s3:PutBucketTagging",
        "s3:GetBucketPublicAccessBlock", "s3:PutBucketPublicAccessBlock",
        "s3:GetBucketOwnershipControls", "s3:PutBucketOwnershipControls",
        "s3:GetEncryptionConfiguration", "s3:PutEncryptionConfiguration", "s3:DeleteBucketEncryption",
        "s3:GetLifecycleConfiguration", "s3:PutLifecycleConfiguration", "s3:DeleteBucketLifecycle",
        "s3:GetBucketVersioning", "s3:PutBucketVersioning",
        "s3:GetAccelerateConfiguration", "s3:PutAccelerateConfiguration",
        "s3:GetAnalyticsConfiguration", "s3:PutAnalyticsConfiguration", "s3:DeleteBucketAnalyticsConfiguration",
        "s3:GetBucketAbac", "s3:PutBucketAbac",
        "s3:GetBucketCORS", "s3:PutBucketCORS", "s3:DeleteBucketCors",
        "s3:GetBucketDefaultStorageClass", "s3:PutBucketDefaultStorageClass",
        "s3:GetBucketLogging", "s3:PutBucketLogging",
        "s3:GetBucketMetadataTableConfiguration", "s3:DeleteBucketMetadataTableConfiguration",
        "s3:GetBucketNotification", "s3:PutBucketNotification",
        "s3:GetBucketObjectLockConfiguration",
        "s3:GetBucketWebsite", "s3:PutBucketWebsite", "s3:DeleteBucketWebsite",
        "s3:GetIntelligentTieringConfiguration", "s3:PutIntelligentTieringConfiguration",
        "s3:GetInventoryConfiguration", "s3:PutInventoryConfiguration",
        "s3:GetMetricsConfiguration", "s3:PutMetricsConfiguration", "s3:DeleteBucketMetricsConfiguration",
        "s3:GetReplicationConfiguration", "s3:DeleteBucketReplication"
      ],
      "Resource": "arn:aws:s3:::${MEDIA_BUCKET}"
    },
    {
      "Sid": "MediaBucketObjectLevelFromBucketHandler",
      "Effect": "Allow",
      "Action": ["s3:DeleteObject", "s3:PutObjectAcl"],
      "Resource": "arn:aws:s3:::${MEDIA_BUCKET}/*"
    }
  ]
}
JSON

# Ações dos handlers deixadas de fora DE PROPÓSITO, formato padrão|condição|motivo.
#   always   = vale sempre
#   zip-only = vale só se o template (--template) mostrar que a Lambda é .zip;
#              com PackageType: Image, ImageUri ou ImageConfig no template, ou
#              sem --template, a ação volta a ser exigida.
# O pré-voo aceita a falta só destas; qualquer outra faltando faz o script parar.
cat > "${WORKDIR}/exclusions.txt" <<'TXT'
s3:PutBucketObjectLockConfiguration|always|Object Lock não é usado; ligado por engano, impediria apagar o bucket no rollback
s3:PutObjectLockConfiguration|always|idem (Object Lock)
s3:PutBucketReplication|always|replicação não é usada (exigiria iam:PassRole de uma role de replicação, que não é concedido)
s3:PutReplicationConfiguration|always|idem (replicação)
s3:CreateBucketMetadataTableConfiguration|always|S3 Metadata/Tables não é usado
s3:UpdateBucketMetadata*TableConfiguration|always|S3 Metadata/Tables não é usado
s3tables:*|always|S3 Tables não é usado
lambda:GetCodeSigningConfig|always|code signing não é usado (o recurso seria um ARN de code-signing-config)
lambda:PassCapacityProvider|always|Lambda Managed Instances (capacity provider) não é usado
s3files:ListMountTargets|always|montagem de sistema de arquivos na Lambda não é usada
ecr:BatchGetImage|zip-only|Lambda por imagem de contêiner não é usada (deploy em .zip)
ecr:GetDownloadUrlForLayer|zip-only|Lambda por imagem de contêiner não é usada (deploy em .zip)
logs:CreateLogDelivery|always|entrega de logs para Firehose/S3 não é usada
firehose:TagDeliveryStream|always|idem (entrega de logs)
s3:REST.PUT.OBJECT|always|idem (entrega de logs para S3; não é uma ação IAM de verdade)
logs:PutBearerTokenAuthentication|always|ingestão por bearer token não é usada
TXT

# --- 0a. Concorrência da conta (só leitura) ----------------------------------
echo
echo "[0a] Concorrência Lambda da conta:"
aws lambda get-account-settings \
  --query 'AccountLimit.{ConcurrentExecutions:ConcurrentExecutions,UnreservedConcurrentExecutions:UnreservedConcurrentExecutions}' \
  --output table
CONCURRENCY_LIMIT="$(aws lambda get-account-settings --query 'AccountLimit.ConcurrentExecutions' --output text)"
if (( CONCURRENCY_LIMIT >= 1000 )); then
  echo "     Limite ${CONCURRENCY_LIMIT} >= 1000 → template com ReservedConcurrency=5."
else
  echo "     Limite ${CONCURRENCY_LIMIT} < 1000 → template SEM concorrência reservada (ReservedConcurrency=0)."
fi

# --- 0b. Pré-voo: handlers dos tipos do template x policy de deploy -----------
echo
echo "[0b] Pré-voo: conferindo handlers create/read/update/delete via describe-type"
TEMPLATE_FILE=""
if [[ -n "${TEMPLATE_SRC}" ]]; then
  TEMPLATE_FILE="${WORKDIR}/template.yaml"
  if [[ "${TEMPLATE_SRC}" == https://* ]]; then
    curl -fsSL "${TEMPLATE_SRC}" -o "${TEMPLATE_FILE}"
  elif [[ -f "${TEMPLATE_SRC}" ]]; then
    cp "${TEMPLATE_SRC}" "${TEMPLATE_FILE}"
  else
    echo "ERRO: --template não encontrado: ${TEMPLATE_SRC}" >&2
    exit 2
  fi
fi

SCHEMA_FILES=()
for t in "${TEMPLATE_TYPES[@]}"; do
  f="${WORKDIR}/schema-${t//::/-}.json"
  aws cloudformation describe-type --type RESOURCE --type-name "${t}" --query Schema --output text > "${f}"
  SCHEMA_FILES+=("${f}")
done

python3 - "${WORKDIR}/deploy-policy.json" "${WORKDIR}/exclusions.txt" "${TEMPLATE_FILE}" "${TEMPLATE_TYPES[*]}" "${SCHEMA_FILES[@]}" <<'PY'
import fnmatch, json, re, sys

policy_path, exclusions_path, template_path, checked_types_str, *schema_paths = sys.argv[1:]
checked_types = set(checked_types_str.split())

policy = json.load(open(policy_path))
granted = set()
for st in policy["Statement"]:
    acts = st["Action"] if isinstance(st["Action"], list) else [st["Action"]]
    granted.update(a.lower() for a in acts)

# --- Template: tipo de pacote e coerência com os tipos conferidos ----------
problems = []
is_zip = False
if not template_path:
    print("     Template: não informado (--template) → exclusões zip-only DESATIVADAS (falha fechada).")
else:
    text = open(template_path, encoding="utf-8").read()
    if not re.search(r"^Resources\s*:", text, re.M) and '"Resources"' not in text:
        problems.append("o arquivo passado em --template não parece um template (sem 'Resources').")
    # Chaves só contam no início da linha (comentários '#' não disparam).
    image_markers = {
        "PackageType: Image": r'^\s*"?PackageType"?\s*:\s*["\']?Image\b',
        "ImageUri": r'^\s*"?ImageUri"?\s*:',
        "ImageConfig": r'^\s*"?ImageConfig"?\s*:',
    }
    found_image = [name for name, rx in image_markers.items() if re.search(rx, text, re.M)]
    is_zip = not found_image
    if found_image:
        print(f"     Template: Lambda por IMAGEM ({', '.join(found_image)}) → exclusões zip-only DESATIVADAS.")
    else:
        print("     Template: Lambda em .zip (sem PackageType: Image, ImageUri, ImageConfig) → exclusões zip-only ativas.")
    # Tipos declarados no template precisam estar entre os conferidos aqui.
    declared = set(re.findall(r'^\s*"?Type"?\s*:\s*["\']?(AWS::[A-Za-z0-9]+::[A-Za-z0-9]+)', text, re.M))
    declared = {"AWS::Lambda::Function" if t == "AWS::Serverless::Function" else t for t in declared}
    for t in sorted(declared - checked_types):
        problems.append(f"tipo {t} está no template mas os handlers dele não são conferidos (incluir em TEMPLATE_TYPES).")
    # Propriedades SAM que geram recursos extras, fora dos 5 tipos conferidos.
    for key in ("AutoPublishAlias", "DeploymentPreference", "EventInvokeConfig", "ProvisionedConcurrencyConfig", "Events"):
        if re.search(rf'^\s*"?{key}"?\s*:', text, re.M):
            problems.append(f"o template usa {key}, que faz o SAM gerar recursos não conferidos por este pré-voo.")

exclusions = []
for line in open(exclusions_path, encoding="utf-8"):
    line = line.strip()
    if line:
        pat, cond, why = line.split("|", 2)
        if cond == "always" or (cond == "zip-only" and is_zip):
            exclusions.append((pat.lower(), why))

def is_granted(action):
    a = action.lower()
    return any(fnmatch.fnmatchcase(a, g) for g in granted)

def exclusion_for(action):
    a = action.lower()
    return next((why for pat, why in exclusions if fnmatch.fnmatchcase(a, pat)), None)

missing, excluded = [], []
for path in schema_paths:
    schema = json.load(open(path))
    type_name = schema["typeName"]
    actions = set()
    for handler in ("create", "read", "update", "delete"):
        actions.update(schema.get("handlers", {}).get(handler, {}).get("permissions", []))
    n_ok = 0
    for action in sorted(actions):
        if is_granted(action):
            n_ok += 1
        elif (why := exclusion_for(action)):
            excluded.append((type_name, action, why))
        else:
            missing.append((type_name, action))
    print(f"     {type_name:26} {len(actions):3} ações nos handlers, {n_ok:3} concedidas")

if excluded:
    print("\n     Fora de propósito (recursos que o template não usa):")
    for type_name, action, why in excluded:
        print(f"       - {action}  [{type_name}]  {why}")

if missing:
    print("\n     FALTANDO na policy de deploy:")
    for type_name, action in missing:
        print(f"       - {action}  [{type_name}]")
if problems:
    print("\n     PROBLEMAS no template:")
    for p in problems:
        print(f"       - {p}")
if missing or problems:
    print("\n     O script vai parar; nada foi criado.")
    sys.exit(1)

print("\n     OK: nenhuma ação dos handlers falta, fora as exclusões acima.")
print("     (O pré-voo confere nomes de ação; o escopo de recurso de cada uma está na policy.)")
PY

if [[ "${CHECK_ONLY}" == "true" ]]; then
  echo
  echo "--check-only: nada foi criado."
  exit 0
fi

# --- 1. Provedor OIDC do GitHub ----------------------------------------------
echo
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "${OIDC_ARN}" >/dev/null 2>&1; then
  echo "[1/4] Provedor OIDC do GitHub já existe: ${OIDC_ARN}"
  if ! aws iam get-open-id-connect-provider --open-id-connect-provider-arn "${OIDC_ARN}" \
       --query 'ClientIDList' --output text | tr '\t' '\n' | grep -qx 'sts.amazonaws.com'; then
    echo "      Adicionando client id sts.amazonaws.com ao provedor existente."
    aws iam add-client-id-to-open-id-connect-provider \
      --open-id-connect-provider-arn "${OIDC_ARN}" --client-id sts.amazonaws.com
  fi
else
  echo "[1/4] Criando provedor OIDC do GitHub."
  # O IAM não exige mais thumbprint para o GitHub. Se o seu CLI recusar sem ele,
  # rode `aws --version`, atualize o CLI e repita (não invente um thumbprint).
  aws iam create-open-id-connect-provider \
    --url "https://${OIDC_HOST}" \
    --client-id-list sts.amazonaws.com \
    --tags Key=Project,Value=erentav-meta-mcp
fi

# --- 2. Role de execução da Lambda -------------------------------------------
if aws iam get-role --role-name "${EXEC_ROLE}" >/dev/null 2>&1; then
  echo "[2/4] Role ${EXEC_ROLE} já existe; atualizando trust policy."
  aws iam update-assume-role-policy --role-name "${EXEC_ROLE}" \
    --policy-document "file://${WORKDIR}/exec-trust.json"
else
  echo "[2/4] Criando role ${EXEC_ROLE}."
  # shellcheck disable=SC2086
  aws iam create-role --role-name "${EXEC_ROLE}" \
    --description "Execucao da Lambda ${FUNCTION_NAME} (logs, SSM ${SSM_PATH}, S3 inbox)" \
    --assume-role-policy-document "file://${WORKDIR}/exec-trust.json" \
    --max-session-duration 3600 \
    --tags ${TAGS} >/dev/null
fi
aws iam put-role-policy --role-name "${EXEC_ROLE}" --policy-name "${EXEC_ROLE}-inline" \
  --policy-document "file://${WORKDIR}/exec-policy.json"

# --- 3. Role de deploy (GitHub Actions via OIDC) -----------------------------
if aws iam get-role --role-name "${DEPLOY_ROLE}" >/dev/null 2>&1; then
  echo "[3/4] Role ${DEPLOY_ROLE} já existe; atualizando trust policy."
  aws iam update-assume-role-policy --role-name "${DEPLOY_ROLE}" \
    --policy-document "file://${WORKDIR}/deploy-trust.json"
else
  echo "[3/4] Criando role ${DEPLOY_ROLE}."
  # shellcheck disable=SC2086
  aws iam create-role --role-name "${DEPLOY_ROLE}" \
    --description "Deploy da stack ${STACK_NAME} via GitHub Actions (${GITHUB_REPO}, env ${GITHUB_ENVIRONMENT})" \
    --assume-role-policy-document "file://${WORKDIR}/deploy-trust.json" \
    --max-session-duration 3600 \
    --tags ${TAGS} >/dev/null
fi
aws iam put-role-policy --role-name "${DEPLOY_ROLE}" --policy-name "${DEPLOY_ROLE}-inline" \
  --policy-document "file://${WORKDIR}/deploy-policy.json"

# --- 4. Bucket de artefatos do SAM -------------------------------------------
if aws s3api head-bucket --bucket "${ARTIFACTS_BUCKET}" >/dev/null 2>&1; then
  echo "[4/4] Bucket ${ARTIFACTS_BUCKET} já existe."
else
  echo "[4/4] Criando bucket ${ARTIFACTS_BUCKET}."
  aws s3api create-bucket --bucket "${ARTIFACTS_BUCKET}" \
    --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
fi
aws s3api put-public-access-block --bucket "${ARTIFACTS_BUCKET}" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-ownership-controls --bucket "${ARTIFACTS_BUCKET}" \
  --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
aws s3api put-bucket-encryption --bucket "${ARTIFACTS_BUCKET}" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-bucket-lifecycle-configuration --bucket "${ARTIFACTS_BUCKET}" \
  --lifecycle-configuration '{"Rules":[{"ID":"expire-old-artifacts","Status":"Enabled","Filter":{"Prefix":""},"Expiration":{"Days":90},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}}]}'
aws s3api put-bucket-tagging --bucket "${ARTIFACTS_BUCKET}" \
  --tagging 'TagSet=[{Key=Project,Value=erentav-meta-mcp},{Key=ManagedBy,Value=cloudshell-fase1}]'

# --- Resumo ------------------------------------------------------------------
echo
echo "Pronto. Cole estes valores de volta no chat (não são segredos):"
echo "  EXEC_ROLE_ARN=$(aws iam get-role --role-name "${EXEC_ROLE}" --query Role.Arn --output text)"
echo "  DEPLOY_ROLE_ARN=$(aws iam get-role --role-name "${DEPLOY_ROLE}" --query Role.Arn --output text)"
echo "  ARTIFACTS_BUCKET=${ARTIFACTS_BUCKET}"
echo "  CONCURRENCY_LIMIT=${CONCURRENCY_LIMIT}"
