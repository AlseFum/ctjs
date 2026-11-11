# GitHub release checklist

This is a personal, experimental project.  It is **not currently published to
npm**.  The package is not marked private, so publishing remains possible, but
it is a deliberate manual step.

## Repository setup

1. Repository name: `ctjs`.
2. The package is not private.  `npm publish` is still a deliberate action; do
   not run it unless you have checked the package name and the release contents.
3. Repository metadata is already set in `package.json`:

   ```json
   "repository": {
     "type": "git",
     "url": "git+https://github.com/AlseFum/ctjs.git"
   },
   "homepage": "https://github.com/AlseFum/ctjs#readme",
   "bugs": {
     "url": "https://github.com/AlseFum/ctjs/issues"
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
git remote add origin git@github.com:AlseFum/ctjs.git
git push -u origin main
```

## CI workflow

The workflow file is at `.github/workflows/ci.yml`.  If the repository shows no
Actions workflow, add that file through the GitHub web UI, or push it with a
token that has `Workflows: Read and write`.  A token with only `Contents` access
cannot create workflow files.

## Repository page

- Description: `A staged compile-time layer for JavaScript — experimental`
- Topics: `javascript`, `compiler`, `compile-time`, `metaprogramming`,
  `experimental`, `babel`
- Enable GitHub Actions after the workflow file exists
- Pin the README or `docs/semantics.md`
- Add the CI badge once the repository URL is known:

  ```md
  [![CI](https://github.com/AlseFum/ctjs/actions/workflows/ci.yml/badge.svg)](https://github.com/AlseFum/ctjs/actions/workflows/ci.yml)
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
