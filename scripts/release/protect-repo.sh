#!/usr/bin/env bash
#
# Locks down the public repo so the release keys can only ever be used by a release you approved.
# Safe to run again: every step updates what's there instead of adding a second copy.
#
#   scripts/release/protect-repo.sh                      # algolab-cloud/jefi-mail-oss
#   JEFI_RELEASE_REPO=owner/name scripts/release/protect-repo.sh
#
# 1. The `release` environment holds the keys. Only v* tags may deploy to it, and every run waits
#    for a required reviewer (you) before any step can read a secret.
# 2. Tags: only admins can create, move or delete v* tags, so nobody else can start a release.
# 3. main: no force pushes or deletion; changes from anyone but admins go through a pull request.
# 4. Actions: workflows get a read-only token by default, and pull requests from outside
#    contributors wait for approval before they run.
# 5. Security features: private vulnerability reporting (SECURITY.md), Dependabot alerts and
#    security updates, and secret scanning that blocks a push containing a key.
#
# Undo any of it under Settings → Environments, Rules, Actions, and Advanced Security.

set -euo pipefail

REPO="${JEFI_RELEASE_REPO:-algolab-cloud/jefi-mail-oss}"
ENVIRONMENT="${JEFI_RELEASE_ENV:-release}"
ADMIN_ROLE=5 # GitHub's built-in repository role id for Admin

command -v gh >/dev/null || { echo "Needs the GitHub CLI (gh)."; exit 1; }
command -v jq >/dev/null || { echo "Needs jq."; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Sign in first: gh auth login"; exit 1; }

me=$(gh api user --jq .id)
login=$(gh api user --jq .login)
echo "Protecting $REPO (reviewer: $login)"

# 1. The release environment: tags only, approved by you.
gh api -X PUT "repos/$REPO/environments/$ENVIRONMENT" --input - >/dev/null <<JSON
{
  "wait_timer": 0,
  "prevent_self_review": false,
  "reviewers": [{ "type": "User", "id": $me }],
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
}
JSON
if ! gh api "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" --jq '.branch_policies[] | select(.type == "tag" and .name == "v*") | .id' | grep -q .; then
  gh api -X POST "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" -f name='v*' -f type=tag >/dev/null
fi
echo "  ✓ environment $ENVIRONMENT: v* tags only, waits for $login"

# Creates the ruleset called $1 from the JSON on stdin, or updates it if it's there already.
ruleset() {
  local name="$1" body id
  body=$(cat)
  id=$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$name\") | .id")
  if [[ -n "$id" ]]; then gh api -X PUT "repos/$REPO/rulesets/$id" --input - >/dev/null <<<"$body"
  else gh api -X POST "repos/$REPO/rulesets" --input - >/dev/null <<<"$body"; fi
  echo "  ✓ ruleset: $name"
}

# 2. Release tags: admins only.
ruleset "Release tags" <<JSON
{
  "name": "Release tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "rules": [{ "type": "creation" }, { "type": "update" }, { "type": "deletion" }, { "type": "non_fast_forward" }],
  "bypass_actors": [{ "actor_id": $ADMIN_ROLE, "actor_type": "RepositoryRole", "bypass_mode": "always" }]
}
JSON

# 3. main: reviewed pull requests (by the code owner, .github/CODEOWNERS) that pass the tests and the
#    dependency review; no history rewrites. Admins may still push (bun run release does).
ruleset "Protect main" <<JSON
{
  "name": "Protect main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
      "required_approving_review_count": 1,
      "dismiss_stale_reviews_on_push": true,
      "require_code_owner_review": true,
      "require_last_push_approval": true,
      "required_review_thread_resolution": false
    } },
    { "type": "required_status_checks", "parameters": {
      "strict_required_status_checks_policy": false,
      "required_status_checks": [{ "context": "App (typecheck + tests)" }, { "context": "review" }]
    } }
  ],
  "bypass_actors": [{ "actor_id": $ADMIN_ROLE, "actor_type": "RepositoryRole", "bypass_mode": "always" }]
}
JSON

# 4. Actions: a read-only token unless a workflow asks for more, and outside contributors wait.
gh api -X PUT "repos/$REPO/actions/permissions/workflow" -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false >/dev/null
gh api -X PUT "repos/$REPO/actions/permissions/fork-pr-contributor-approval" -f approval_policy=all_external_contributors >/dev/null
echo "  ✓ actions: read-only token by default; outside contributors' pull requests wait for approval"

# 5. Security features (free on public repositories).
gh api -X PUT "repos/$REPO/private-vulnerability-reporting" >/dev/null
gh api -X PUT "repos/$REPO/vulnerability-alerts" >/dev/null
gh api -X PUT "repos/$REPO/automated-security-fixes" >/dev/null
gh api -X PATCH "repos/$REPO" --input - >/dev/null <<JSON
{
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" }
  }
}
JSON
echo "  ✓ security: private reporting, Dependabot alerts and fixes, secret scanning with push protection"

cat <<DONE

Done. Next, put the release keys in the environment (never as repo-wide secrets):
  scripts/release/setup-signing.sh                       certificate, identity, notarization
  scripts/release/setup-communication-notifications.sh   optional: sender pictures on banners
  gh secret set CLOUDFLARE_API_TOKEN  --repo $REPO --env $ENVIRONMENT   (R2 write to jefi-downloads only)
  gh secret set CLOUDFLARE_ACCOUNT_ID --repo $REPO --env $ENVIRONMENT
DONE
