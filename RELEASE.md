# RELEASE.md

## AgentActa Release Process (solo maintainer)

This repo uses protected `main` with **PR required** and **0 required approvals**.

### 1) Prepare
- Ensure branch is clean and tests pass:
  - `npm test`
- Update `CHANGELOG.md` with a dated section.
- Choose semver:
  - patch = fixes only
  - minor = new user-visible features (default)
  - major = breaking behavior/API

### 2) Open/merge PR
- Push feature branch
- Open PR to `main`
- Merge PR (squash preferred)

### 3) Cut release
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

### 4) Publish to npm
From local main after merge/tag:
```bash
npm whoami
npm publish
```

Verify publication:
```bash
npm view agentacta versions --json | python3 -c "import json,sys;v=json.load(sys.stdin);print(v[-5:])"
```

### 5) GitHub release
```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <(sed -n '/## \[X.Y.Z\]/,/## \[/p' CHANGELOG.md)
```

### 6) Deploy/runtime check
- Restart service if needed:
  - `systemctl --user restart agentacta`
- Verify:
  - `curl -I http://127.0.0.1:4003`

