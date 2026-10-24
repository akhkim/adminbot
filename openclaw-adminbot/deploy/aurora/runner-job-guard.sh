#!/usr/bin/env bash
# Job-started hook for the self-hosted runner on Aurora (ACTIONS_RUNNER_HOOK_JOB_STARTED).
#
# The repository is public and has many writers. Any workflow that names this runner's label --
# on a pushed branch, or in a fork's pull request -- would otherwise run as the service account,
# next to the lab's credentials and member database. The runner executes this hook before any step
# of every job and fails the job when it exits non-zero, so it is the gate that lets exactly one
# workflow through: the deploy workflow as it exists on main.
#
# install-actions-runner.sh copies this file next to the runner and substitutes the allowed values
# below. They are written into the installed copy rather than read from the environment because a
# workflow controls its jobs' environment; the GITHUB_* values checked here are set by GitHub and
# cannot be overridden by a workflow.
set -euo pipefail
PATH=/usr/bin:/bin

allowed_repository="__ALLOWED_REPOSITORY__"
allowed_workflow_ref="__ALLOWED_WORKFLOW_REF__"

refuse() {
  printf 'Refusing job on the Aurora deploy runner: %s\n' "$*" >&2
  printf 'Only %s may run here.\n' "$allowed_workflow_ref" >&2
  exit 1
}

[[ "$allowed_repository" != __* && "$allowed_workflow_ref" != __* ]] ||
  refuse "the guard was installed without its allowed values"
[[ "${GITHUB_REPOSITORY:-}" == "$allowed_repository" ]] ||
  refuse "repository is '${GITHUB_REPOSITORY:-unset}'"
[[ "${GITHUB_WORKFLOW_REF:-}" == "$allowed_workflow_ref" ]] ||
  refuse "workflow is '${GITHUB_WORKFLOW_REF:-unset}'"
case "${GITHUB_EVENT_NAME:-}" in
  workflow_run | workflow_dispatch) ;;
  *) refuse "event is '${GITHUB_EVENT_NAME:-unset}'" ;;
esac
[[ "${GITHUB_REF:-}" == refs/heads/main ]] ||
  refuse "ref is '${GITHUB_REF:-unset}'"
printf 'Aurora deploy runner: %s (%s) allowed\n' "$GITHUB_WORKFLOW_REF" "$GITHUB_EVENT_NAME"
