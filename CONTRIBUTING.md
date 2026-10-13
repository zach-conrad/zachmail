# Conventions

- Specs: architecture and build plan live in the ZachMail project files (`architecture/ARCHITECTURE.md`,
  `architecture/BUILD_PLAN.md`), design in `design/zachmail-design.md`. Follow them; change the docs, not ad hoc.
- Speed budgets (architecture §1a) are hard requirements. Never put a network call on the click
  path; render from local state. Keep the initial web bundle under 200 KB gzip (`pnpm size`).
- Every key binding lives in `packages/core/src/keymap.ts`; never hardcode keys in components.
- Colors, type and spacing come from `packages/tokens/tokens.json` via CSS variables; no literal colors in CSS.
- Server schema changes: edit `packages/db/src/server/schema.ts` and run `pnpm --filter @zachmail/db generate`;
  hand-written SQL goes in a `--custom` migration, and `packages/db/test` must still pass.
- TypeScript is pinned to 6.0.x because typescript-eslint does not support 7 yet.
- Before pushing: `pnpm exec prettier --check . && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm size`.
