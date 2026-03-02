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
cd ~/Developer/agentacta
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

### 4) GitHub release
```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <(sed -n '/## \[X.Y.Z\]/,/## \[/p' CHANGELOG.md)
```

### 5) Deploy/runtime check
- Restart service if needed:
  - `systemctl --user restart agentacta`
- Verify:
  - `curl -I http://127.0.0.1:4003`

## Current guidance
For the just-shipped realtime session work, use **v1.3.0**.
