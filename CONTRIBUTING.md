# Contributing

1. Fork, create a branch, keep commits small and focused.
2. `yarn` (Node.js 24, Yarn 1; no token needed), then `yarn dev`.
3. Before a pull request: `yarn typecheck`, `yarn lint`, `yarn format:check`, `yarn test`. CI runs the same checks on Windows, macOS and Linux and packages the app.
4. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first: the safety rules (the app only removes what it created, never overwrites files it does not know) are not negotiable, and changes to the sync engine need tests, including the fault-injection ones in `src/engine/faults.test.ts`.
5. User-visible texts go through vue-i18n (renderer) or `src/main/i18n` (main) in all eight languages: Italian, English, German, Spanish, French, Russian, Swedish, Chinese. `src/renderer/src/i18n/messages.test.ts` checks the keys, the placeholders and the plural forms.
6. Never commit Font Awesome Pro material (`src/renderer/src/lib/icons/pro.generated.ts` is ignored on purpose) or other proprietary assets.
7. Formatting-only commits are listed in `.git-blame-ignore-revs`: run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once and `git blame` skips them, as GitHub does. Add the commit of any new repository-wide formatting there.
