#!/usr/bin/env bash
# PROTOTYPE (PR view). Prepares one PR for analysis:
#   prepare.sh <local clone> <owner/repo> <pr number>
# Fetches the PR's head into the local clone, then checks the base (the merge base with the PR's
# base branch) and the head out as two detached worktrees under
# ${XDG_CACHE_HOME:-~/.cache}/beghu-pr-view/<owner>-<repo>-<n>/{base,head}. It also writes
# pr.json there (title, body, SHAs, every changed file with its counts). Prints the directory.
# Remove the worktrees with: git -C <clone> worktree remove <dir>/base (and head).
set -euo pipefail
clone=$1 repo=$2 n=$3
dir="${XDG_CACHE_HOME:-$HOME/.cache}/beghu-pr-view/${repo//\//-}-$n"
mkdir -p "$dir"

meta=$(gh pr view "$n" -R "$repo" --json number,title,body,url,author,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles)
head=$(jq -r .headRefOid <<<"$meta")
baseref=$(jq -r .baseRefName <<<"$meta")
git -C "$clone" fetch -q origin "$baseref" "pull/$n/head"
base=$(git -C "$clone" merge-base "origin/$baseref" "$head")

for side in base head; do
  sha=$([ "$side" = base ] && echo "$base" || echo "$head")
  if [ -d "$dir/$side" ]; then
    git -C "$dir/$side" checkout -q --detach "$sha"
  else
    git -C "$clone" worktree add -q --detach "$dir/$side" "$sha"
  fi
done

files=$(gh api --paginate "repos/$repo/pulls/$n/files?per_page=100" \
  --jq '.[] | {path: .filename, status, additions, deletions, previous: .previous_filename}' | jq -s .)
jq -n --argjson m "$meta" --argjson files "$files" --arg base "$base" --arg repo "$repo" '{
  repo: $repo, number: $m.number, title: $m.title, url: $m.url, author: $m.author.login,
  description: $m.body, baseRef: $m.baseRefName, headRef: $m.headRefName,
  baseSha: $base, headSha: $m.headRefOid,
  stats: {files: $m.changedFiles, additions: $m.additions, deletions: $m.deletions},
  files: $files
}' >"$dir/pr.json"
echo "$dir"
