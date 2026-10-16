# ZachMail iOS

Expo (SDK 57) + expo-router app, iOS 26 only. Mail lives in an on-device SQLite replica: the shared
`SqlStore` from `hub/local-store` on expo-sqlite, fed by the shared `SyncClient` from
`hub/core`.

- Without `EXPO_PUBLIC_API_URL` the app opens an in-memory demo mailbox, fresh each launch.
- With it set, the replica persists to `zachmail.db` and syncs once sign-in calls `connectSync`
  (iOS sign-in is not built yet).

- `pnpm --filter @zachhub/ios dev`: Metro for a development build (`expo run:ios` or an EAS dev client; Expo Go lacks some native modules).
- `pnpm --filter @zachhub/ios build`: bundles the iOS JS with `expo export`, which is how CI checks the app compiles.
- EAS: `eas build -p ios --profile development` (Xcode 26 image, deployment target 26.0).

Layout: `app/` routes (native tabs, thread, compose sheet, split and snooze sheets); `src/mail/` the
store and command layer, swipe, snooze and palette matching (unit-tested on sqlite-wasm, no React
Native imports); `src/data/` the expo-sqlite driver and sync wiring; `src/theme/` the
theme built from `hub/tokens/tokens.json`; `src/ui/` shared views, including `GlassSurface`,
the only place Liquid Glass is drawn (design §5.6).
