# Upstream Merge Workflow

## Principles

- Merge or cherry-pick one upstream commit at a time; never apply a large batch without review.
- Before each commit, summarize the change and ask the user to choose `keep`, `skip`, or `combine`.
- When a conflict appears, stop and show the relevant differences. Ask for a decision per file or logical group.
- Do not guess when a conflict could remove a fork-specific feature.
- Preserve fork changes already confirmed by the user, including lyrics, Spotify artist tracks/cover fallback, provider switching, `scrollbar-hide`, Saving Storage Mode, and target-specific overrides.
- Do not push automatically. Do not run build/tests unless explicitly requested.

## Conflict decisions

- `keep current`: keep the fork/ours side.
- `keep upstream`: apply the upstream/theirs side.
- `combine`: retain both changes when they are independent; when logic overlaps, use the upstream architecture and re-add the confirmed fork behavior.
- After resolving a conflict, verify that no conflict markers remain, stage the file, and continue the cherry-pick.
- If a cherry-pick is empty because the change already exists, skip it and report that clearly.

## Workflow

1. Check the worktree before starting.
2. Identify the next commit and inspect its stat/diff.
3. Ask the user for the commit decision.
4. Cherry-pick the commit only after the user chooses.
5. For every conflict, show the difference, ask for a decision, and resolve accordingly.
6. Check status and conflict markers before `git cherry-pick --continue`.
7. Report the resulting commit, resolved conflicts, and any remaining uncommitted changes.

## Known preferences

- Do not restore the Footer when the user has requested its removal.
- Do not hide Playlists/Requests only because no download client is configured when the user has chosen to keep them.
- When upstream replaces a large UI or schema, do not blindly choose one side if that would lose fork functionality; ask and combine by logical section.
