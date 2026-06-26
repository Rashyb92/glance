# Dependency upgrade runbook

Glance pins dependencies and upgrades them **deliberately and tested**, never with
blind bumps. Routine currency is automated by Dependabot (`.github/dependabot.yml`):
grouped PRs every week, each gated by CI (`typecheck → lint → test → build`). Merge
the green ones.

The **major** upgrades below are staged. Do them one at a time, each on its own
branch, running `pnpm verify` after each step and only proceeding when green. This
is the order of least to most blast-radius.

| # | Upgrade | Why staged separately | Watch for |
|---|---------|----------------------|-----------|
| 1 | `vitest` 2 → 3 | Test runner only; fails loud and early | config key renames |
| 2 | `@typescript-eslint` + `eslint` → 9/flat-or-10 | Flat-config migration | `eslint.config.js` shape |
| 3 | `typescript` 5.x → latest | Stricter inference may surface new type errors | `noUncheckedIndexedAccess` edges |
| 4 | `vite` 5 → 7 | Dev/build server; plugin compatibility | `@vitejs/plugin-react` peer range |
| 5 | `react`/`react-dom` 18 → 19 | Runtime behavior (effects, transitions) | the HUD audio effects, Strict-mode double-invoke |
| 6 | `@anthropic-ai/sdk` → latest | Provider API surface | `messages.create` params, model ids |

## Procedure (per upgrade)

```bash
git checkout -b deps/<name>
pnpm up <package>@<version> -r        # -r = across the workspace
pnpm install
pnpm verify                            # typecheck + lint + test + build
# fix anything red, commit, push, open PR, let CI confirm, merge
```

## Notes

- **React 19** is the highest-risk step. Test the HUD's audio/earcon effects and the
  reconnect logic manually after upgrading; React 19 changes effect timing.
- **Anthropic SDK**: pin the model ids in `packages/ai` and re-check
  `messages.create` parameters against the current SDK before bumping.
- Keep Node pinned to the CI version (24) and the `engines` floor in `package.json`
  in sync with what you actually run.
