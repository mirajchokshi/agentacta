# RELEASE.md

## AgentActa Release Process (PR-first)

This repo uses protected `main` with **PR required** and **0 required approvals**.
Policy: do not release until code review has happened and review comments are resolved.

### 1) Prepare
- Ensure branch is clean and tests pass:
  - `npm test`
- Update `CHANGELOG.md` with a dated section.
- Choose semver:
  - patch = fixes only
  - minor = new user-visible features (default)
  - major = breaking behavior/API

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
npm version <patch|minor|major> --no-git-tag-version
# (optional) commit version bump if desired

git add package.json package-lock.json CHANGELOG.md
git commit -m "release: vX.Y.Z"
git push

git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
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
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <(sed -n '/## \[X.Y.Z\]/,/## \[/p' CHANGELOG.md)
```

### 7) Deploy/runtime check
- Restart service if needed:
  - `systemctl --user restart agentacta`
- Verify:
  - `curl -I http://127.0.0.1:4003`

