# Infrastructure pending review

No resource has been provisioned or imported, and no deployment is authorized. The live Vercel, Railway and Supabase services remain the operating stack. These files make an alternative reviewable; they do not migrate the application or adopt existing managed resources into Terraform state.

| Profile | Resources represented | Default / decision |
| --- | --- | --- |
| `disabled` | No AWS resources; a local Terraform approval marker only | Default |
| `registry` | Immutable ECR repository, encryption, basic image scanning, untagged-image expiry | Separate registry approval and budget of at least $1 required |
| `aws-reference` | ECR, VPC, two public and two isolated DB subnets, private encrypted RDS PostgreSQL 17, protected backups; optional ECS Fargate/HTTPS ALB | Separate migration approval, registry approval and reviewed budget of at least $60 required |

`enable_compute=false` is also the default. This permits a future approved database bootstrap before a restricted runtime credential exists. `enable_compute=true` additionally requires a digest-pinned image, validated ACM certificate, and Secrets Manager references for `DATABASE_URL` and `MARKET_EDGE_SECRET`. Terraform never receives secret values. The RDS master secret is AWS-managed and reserved for bootstrap. Create the existing `market_lab_app` role with its 12-connection limit, restore/test the schema and data through a separately approved private administrative path, then create the runtime URL secret. The application must never use the master role. No DNS change, migration, role bootstrap or traffic cutover is automated here.

The reference permits one backend task, the existing four-query-connection pool and one dedicated LISTEN connection. It uses a public task address for HTTPS egress while security groups allow inbound application traffic only from the ALB. The database has no internet route and accepts port 5432 only from the task security group. There is no NAT gateway, Kubernetes cluster, Kafka cluster or automatic scaling. ALB-to-task traffic uses HTTP inside the VPC; end-to-end TLS would require a separate application/certificate configuration review.

The non-root container keeps a read-only root filesystem and a separate ephemeral model-cache mount at `/tmp/market-lab-models`. The Dockerfile must create that directory owned by the node user and declare a matching `VOLUME`; ECS uses the image directory metadata to initialize the volume. This mount uses the task's existing 20-GiB ephemeral allocation and has no separate 128-MiB quota. Application retention limits still apply. It does not enable a model download at task startup. [ECS bind mount ownership and lifetime](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/bind-mounts.html).

Before any RDS activation, supply the correct current RDS CA bundle as backend `DATABASE_CA_CERT` configuration through the reviewed runtime environment/secret mapping and validate certificate verification. Do not weaken `rejectUnauthorized` or reuse a Supabase CA bundle for a different database host.

Deployment uses minimum healthy 0 / maximum 100 percent. This prevents temporary backend duplication against the small database role budget, at the cost of brief replacement downtime and interrupted streams. Increasing replica count or switching to overlapping deployments requires a connection-budget and stream-reconnect review. The single-AZ database and single backend are not a high-availability topology.

## Cost decision

The full AWS profile does not fit the current additional $25/month allowance. The $60 validation threshold is an approval floor, not a quote or a spending cap. At 730 hours/month, AWS's published US East examples imply approximately $10.63 for a 0.25-vCPU/1-GiB Linux/x86 task, $16.43 for an ALB before LCUs, and at least $10.95 for three public IPv4 addresses. That already exceeds $25 before RDS, storage, Secrets Manager, logs, transfer or taxes. Account credits are excluded. Keep the current stack unless a measured reliability or latency need justifies the migration and its full reviewed estimate. [Fargate pricing](https://aws.amazon.com/fargate/pricing/), [ALB pricing](https://aws.amazon.com/elasticloadbalancing/pricing/), [IPv4 pricing](https://aws.amazon.com/vpc/pricing/).

ECR private image storage is published at $0.10/GB-month in AWS's pricing example; registry-only is substantially smaller than compute migration, but still needs explicit approval. Basic scanning is selected; enhanced Inspector scanning is not enabled. [ECR pricing](https://aws.amazon.com/ecr/pricing/).

App Runner is closed to new customers. AWS identifies ECS Express Mode as its migration path; that mode still bills underlying resources. This template uses explicit ECS resources so network, database, deployment and cost choices remain inspectable. [AWS availability notice](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html).

## Local verification

From this directory, run `terraform init -backend=false -input=false -lockfile=readonly`, `terraform fmt -check -recursive`, `terraform validate`, and `terraform test`. Tests use a mocked AWS provider and exercise default-off, registry isolation, approval rejection, DB security, one-task replacement and database-before-compute bootstrap. These checks do not contact AWS APIs or prove account-specific quotas, certificate validity, engine availability or operational recovery. The committed provider lock includes Windows and Linux checksums.

Do not run a real plan/apply against cloud credentials until the migration choice is approved. The `.tfvars.example` contains safe defaults. Local state and plans are ignored. The dormant backend example is for an already reviewed encrypted/versioned S3 state bucket with public access blocked, narrowly scoped IAM, and S3 lockfile access. The bucket is not created by this project.

## CI and exact future settings

`infrastructure-review.yml` runs Terraform mocked plans, meaningful runtime tests with disposable PG17, a Docker build and an unauthenticated health smoke test. It has no cloud credentials and cannot publish or deploy.

`publish-backend-image.yml` is manual and additionally requires repository variable `INFRA_EXTERNAL_ACTIONS_ENABLED=true` and the `main` branch. Leave that variable unset now. Its publishing job uses the `registry-review` GitHub environment. Before enabling it, configure required reviewers, prevent self-review, prohibit protection-rule bypass, and restrict deployment branches to `main`. A missing or unprotected environment is not an approval control. Confirm the repository plan supports these environment protections before enabling external actions.

That environment needs non-secret variables `AWS_REGION`, `AWS_ACCOUNT_ID`, `ECR_REPOSITORY_URL`, and `AWS_IMAGE_PUBLISH_ROLE_ARN`. AWS must have a GitHub OIDC provider with audience `sts.amazonaws.com`. The publisher trust template binds the exact repository and `registry-review` environment. Its permissions template allows registry authentication globally because that ECR API cannot be repository-scoped; layer upload, image publication and digest readback are limited to one repository. It grants no compute, infrastructure, database or secret access. No static AWS access key is used. [GitHub AWS OIDC](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws).

The publishing job tests and builds first, then passes the exact tested image as a one-day artifact to the protected push job. Images contain no environment files. The resulting immutable commit tag and ECR digest are review inputs; publication does not deploy.

`../.github/workflow-templates/aws-deploy.yml.example` is deliberately outside the workflow directory. Activating it requires a later approved change. Its `production-aws` environment must have the same reviewer/branch restrictions and separate deploy-role trust for `repo:OWNER/REPO:environment:production-aws`. Variables additionally required: `AWS_DEPLOY_ROLE_ARN`, `AWS_CERTIFICATE_ARN`, `APPLICATION_SECRET_ARNS_JSON`, `TERRAFORM_STATE_BUCKET` and `TERRAFORM_STATE_REGION`. The JSON contains secret ARNs only. The role must be generated/reviewed from the approved plan and constrained by the target account's permission boundary; no administrator policy is supplied. The apply uses an immutable image digest, an encrypted remote state lock and the exact plan generated in that approved job. Terraform plans/state must never be published as public artifacts.

Database upgrade remains on PostgreSQL 17. A PostgreSQL 18 upgrade requires actual hosting support and extension/restore testing; a newer upstream major alone does not authorize an upgrade.
