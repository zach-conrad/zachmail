# ZachMail iOS

Expo (SDK 57) + expo-router app, iOS 26 only. Phase 8 scaffold: renders a demo mailbox shaped like
`packages/core/src/sync/protocol.ts` until the API and the expo-sqlite replica are wired in.

- `pnpm --filter @zachmail/ios dev`: Metro for a development build (`expo run:ios` or an EAS dev client; Expo Go lacks some native modules).
- `pnpm --filter @zachmail/ios build`: bundles the iOS JS with `expo export`, which is how CI checks the app compiles.
- EAS: `eas build -p ios --profile development` (Xcode 26 image, deployment target 26.0).

Layout: `app/` routes (native tabs, thread, compose sheet, split and snooze sheets); `src/mail/` the
local store, splits, swipe and snooze logic (unit-tested, no React Native imports); `src/theme/` the
theme built from `packages/tokens/tokens.json`; `src/ui/` shared views, including `GlassSurface`,
the only place Liquid Glass is drawn (design §5.6).
