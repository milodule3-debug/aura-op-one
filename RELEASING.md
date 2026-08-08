# Releasing Aura OP One

The npm package is `aura-op-one`; the installed command is `opone`.

## Before the first publish

1. **Settle the repository owner first.** `package.json` carries `repository`,
   `homepage` and `bugs` URLs, and npm renders them on the package page. If the
   repo is going to be transferred, transfer it *before* publishing so those
   URLs point at the final home rather than a redirect.
2. **Confirm the name is still free.** `npm view aura-op-one` should 404. An
   unclaimed name is not a reserved one.
3. **Know that publishing is effectively permanent.** Unpublish is only allowed
   within 72 hours and only when nothing depends on the package; after that the
   version is immutable and the name is yours forever. Getting `0.1.0` wrong
   means shipping `0.1.1`, not undoing it.

## Publish

```bash
npm login          # needs npm 2FA if the account has it enabled
npm publish
```

`prepublishOnly` runs `clean && build && test` first, so a stale or failing
build cannot ship. `dist/` is gitignored — that guard is the only thing
standing between a publish and whatever happened to be on disk. Do not
bypass it with `--ignore-scripts`.

## Verify the published artifact

Publishing succeeded is not the same as the package working. Check the real
install path, in a clean directory:

```bash
cd "$(mktemp -d)" && npm init -y >/dev/null
npm install -g aura-op-one
opone --help
```

Then confirm the binary actually starts against an isolated store, so the
check never touches real data:

```bash
AURA_OP_ONE_DIR=$(mktemp -d) opone
```

You should get the status line and `:help`. If `opone: command not found`, the
`bin` entry or the shebang in `dist/cli.js` is wrong — investigate before
cutting another version.

## Versioning

Semver against the *client's* surface: the `:` commands, the stores' on-disk
shapes, and the exported `Engine` interface.

- **patch** — fixes with no interface or on-disk change
- **minor** — new commands, new `Engine` methods, additive store fields
- **major** — anything that invalidates an existing `~/.aura/op-one/` store, or
  removes/renames a command or `Engine` method

```bash
npm version patch|minor|major   # commits + tags
git push --follow-tags
npm publish
```

## The dependency to watch

`aura-code` is imported by path into its published `dist/`
(`aura-code/dist/agent/loop.js`) because it declares no `exports` map. That is
typed and works, but it depends on an internal layout no semver promise covers
— see architecture §14.8.

**Before bumping the `aura-code` range, run the suite.** The 13 tests in
`tests/engine-integration.test.ts` exercise the real package rather than the
fake engine, and they are what will catch a moved or renamed module. A green
run there is the signal the new version is safe to depend on.
