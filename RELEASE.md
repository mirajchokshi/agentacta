# RELEASE.md

## AgentActa Release Process (PR-first)

This repo uses protected `main` with **PR required** and **0 required approvals**.
Policy: do not release until code review has happened and review comments are resolved.

### 1) Prepare
- Ensure branch is clean and tests pass:
  - `npm test`
- Update `CHANGELOG.md` with a dated section.
- Versioning policy: **CalVer**
  - Normal: `YYYY.M.D` (example: `2026.3.5`)
  - Multiple releases same day: `YYYY.M.D-rN` (example: `2026.3.5-r2`)

### 2) Open PR
- Push feature branch
- Open PR to `main`
- Request/perform code review (even if self-review)
- Resolve review comments
- Re-run tests after final review changes
- Get explicit go-ahead before merge/release actions

### 3) Merge PR
- Merge PR (squash preferred)

### 4) Cut release
From local main:
```bash
git checkout main
git pull

BASE="$(date +%Y.%-m.%-d)"
if npm view "agentacta@${BASE}" version >/dev/null 2>&1; then
  N=2
  while npm view "agentacta@${BASE}-r${N}" version >/dev/null 2>&1; do N=$((N+1)); done
  VER="${BASE}-r${N}"
else
  VER="$BASE"
fi

echo "Releasing $VER"
npm version "$VER" --no-git-tag-version

git add package.json package-lock.json CHANGELOG.md
git commit -m "release: v$VER"
git push

git tag -a "v$VER" -m "v$VER"
git push origin "v$VER"
```

### 5) Publish to npm
From local main after merge/tag:
```bash
npm whoami
npm publish
```

Verify publication:
```bash
npm view agentacta versions --json | python3 -c "import json,sys;v=json.load(sys.stdin);print(v[-5:])"
```

### 6) GitHub release
```bash
gh release create "v$VER" --title "v$VER" --notes-file <(sed -n "/## \[$VER\]/,/## \[/p" CHANGELOG.md)
```

### 7) Deploy/runtime check
- Restart service if needed:
  - `systemctl --user restart agentacta`
- Verify:
  - `curl -I http://127.0.0.1:4003`

