# Predictir repository and browser-data migration

The target repository is `DaniyalHayat/predictir`. This document records the dependency checks required when the coordinator performs the GitHub rename. Changing these source files does not change any cloud connection, identity or deployed resource.

## GitHub and publication identities

Normal checkouts use `actions/checkout` without a hardcoded `repository` argument. They follow the repository running the workflow. Existing commit links and ordinary clone/fetch URLs redirect after a rename, but local Git remotes should be updated. A repository consumed as a reusable GitHub Action is an exception: GitHub does not redirect action references.

Azure image publication uses the `azure-image-publish` protected environment. Its external identity must match issuer `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`, and subject `repo:DaniyalHayat/predictir:environment:azure-image-publish`. The GitHub workflow reads the existing `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` and `AZURE_ACR_NAME` environment variables. The federated credential is externally configured rather than provisioned by the current foundation Terraform. Inspect that exact publisher identity before changing it; do not alter unrelated project identities.

The optional AWS image publisher uses audience `sts.amazonaws.com` and the `registry-review` environment. Its trust template receives `github_repository`; supply `DaniyalHayat/predictir` when rendering it. The future dormant deployment template uses `repo:DaniyalHayat/predictir:environment:production-aws`. These publication paths are disabled unless their explicit enabling variables are set. Renaming the source repository does not authorize enabling them or changing AWS identities.

Microsoft Entra federation matches issuer, audience and subject case-sensitively. A GitHub repository redirect does not make an old token subject equal a new one. Keep existing role permissions narrow; inspect and update only an actual affected publisher credential.

## Connected hosts

- Vercel: verify its existing GitHub connection still references the same repository ID under the new name; retain root `web`, domains, production branch, secrets and route configuration. Confirm a tested new commit deploys.
- Railway: the checked-in `web/infra/railway-service.json` now expects the new slug. Verify the existing source connection, `main`, root `/web`, CI gate and existing service ID after renaming. The reconciliation tool intentionally rejects a different repository rather than silently reconnecting a service.
- Supabase: verify the existing project's GitHub integration still follows the same repository and migrations directory. Do not create a replacement project, change its reference, or replay applied migrations.
- Azure: keep current Container Apps, registry repositories, managed identities, vault, database and Terraform state resource IDs. A cosmetic rename must not replace running resources. The Go component module path follows the new GitHub slug.

Do not reuse the old GitHub repository name, because that would remove its redirect. Preserve the coordinator's private mirror and original audit evidence separately.

## Browser records

The current app writes `predictir:*` keys for paper records, guest/account state, appearance and consent. A one-time migration copies existing legacy values verbatim before the account or paper ledger loads. Existing Predictir values take precedence. A previous analytics denial overrides an allowed preference during migration.

Original local values are retained for recovery; the completion marker prevents deleted or expired guest records from being copied back on a later visit. If storage fills or a write fails, copied values roll back and the original records remain. No paper balance, position, trade, watchlist or account identity is invented. No server credential is migrated.

Legacy infrastructure names and API adapter/environment names remain where changing them would break deployed resources or real data retrieval. Historical observations and source attribution are preserved as evidence.

## Primary guidance

[GitHub repository renames](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository) · [Microsoft workload identity federation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation)

