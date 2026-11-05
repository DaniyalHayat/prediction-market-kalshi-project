#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

terraform output -json profile | jq -e '.azure and .mode=="live" and .bootstrap and (.apps | not)' >/dev/null
subscription=$(terraform output -raw azure_subscription_id)
group=$(terraform output -raw resource_group_name)
job=$(terraform output -raw bootstrap_job_name)

args=(--subscription "$subscription" --resource-group "$group" --name "$job" --only-show-errors)
status_count=$(az containerapp job execution list "${args[@]}" \
  --query "length([?properties.status=='Running' || properties.status=='Processing' || properties.status=='Pending'])" --output tsv)
[[ $status_count == 0 ]] || { printf 'Wait for the current execution before starting another.\n' >&2; exit 1; }
execution=$(az containerapp job start "${args[@]}" --query name --output tsv)
[[ $execution =~ ^[a-zA-Z0-9-]+$ ]] || { printf 'Azure did not report the expected execution ID.\n' >&2; exit 1; }
printf 'Monitoring %s\n' "$execution"

for attempt in {1..42}; do
  state=$(az containerapp job execution show "${args[@]}" --job-execution-name "$execution" \
    --query properties.status --output tsv)
  case "$state" in
    Succeeded) printf 'Bootstrap verified successfully.\n'; exit 0 ;;
    Failed|Stopped|Degraded) printf 'Bootstrap ended with status %s.\n' "$state" >&2; exit 1 ;;
  esac
  sleep 10
done
printf 'Azure did not report a terminal status. Check the execution before trying again.\n' >&2
exit 1
