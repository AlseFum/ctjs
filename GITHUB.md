# GitHub release checklist

This is a personal, experimental project.  It is **not currently published to
npm**.  The package is not marked private, so publishing remains possible, but
it is a deliberate manual step.

## Before the first push

1. Repository name: `ctjs`.
2. The package is not private.  `npm publish` is still a deliberate action; do
   not run it unless you have checked the package name and the release contents.
3. Optional: add repository metadata to `package.json` so the GitHub link appears
   in tooling:

   ```json
   "repository": {
     "type": "git",
     "url": "git+https://github.com/<owner>/ctjs.git"
   },
   "homepage": "https://github.com/<owner>/ctjs#readme",
   "bugs": {
     "url": "https://github.com/<owner>/ctjs/issues"
   }
   ```

## Local checks

```bash
npm ci
npm test
npm run demo
npm pack --dry-run
```

`npm pack --dry-run` is only a sanity check.  It does not publish anything.

## Push

```bash
git init
git add .
git commit -m "feat: initial ctjs compiler"
git branch -M main
git remote add origin git@github.com:<owner>/ctjs.git
git push -u origin main
```

## Repository page

- Description: `A staged compile-time layer for JavaScript — experimental`
- Topics: `javascript`, `compiler`, `compile-time`, `metaprogramming`,
  `experimental`, `babel`
- Enable GitHub Actions (the workflow runs tests, the demo, and a package check)
- Pin the README or `docs/semantics.md`
- Add the CI badge once the repository URL is known:

  ```md
  [![CI](https://github.com/<owner>/ctjs/actions/workflows/ci.yml/badge.svg)](https://github.com/<owner>/ctjs/actions/workflows/ci.yml)
  ```

## Publishing to npm (optional)

This project is not set up as a maintained npm package, but the package is not
marked private.

1. Check that the package name `ctjs` is available, or rename it.
2. Add `repository` / `homepage` / `bugs` to `package.json`.
3. Run:

   ```bash
   npm test
   npm run demo
   npm pack --dry-run
   npm publish --access public
   ```

`prepublishOnly` runs the tests and demo before an accidental publish, but it is
not a substitute for checking the package contents.  If you never publish, the
GitHub repository is the deliverable.
