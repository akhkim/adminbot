# ADR-0003: src/plugin-sdk stays flat — the directory is the export namespace

## Status

Accepted

## Context

`src/plugin-sdk/` holds ~380 non-test files in one flat directory, which the
restructure effort's ≤80-files-per-directory target would normally split. But
the plugin SDK is a published surface, and its resolution is position-dependent
three times over:

- `tsconfig.json` maps `openclaw/plugin-sdk/*` → `./src/plugin-sdk/*.ts` by
  wildcard, so the public subpath of every module _is_ its flat filename.
- `package.json` declares 320 explicit `./plugin-sdk/<name>` export entries
  pointing at the mirrored flat `dist/plugin-sdk/<name>.js`.
- `extensions/tsconfig.package-boundary.*` remaps the same subpaths onto built
  `.d.ts` files so extensions only see the public surface.

Extensions import these subpaths ~600 times. Filenames are already systematic
suffix families (`*-runtime`, `*-contracts`, `memory-core-host-*`), so the flat
listing sorts into legible groups.

## Decision

We will keep `src/plugin-sdk/` flat. One file = one public subpath, and the
directory listing doubles as the SDK's export inventory. The
directory-size ratchet grandfathers it explicitly. Navigation aid comes from
documentation (family prefix table in `docs/architecture.md`), not from moves.

## Alternatives considered

- **Group into subdirs, keep public specifiers via alias entries** — requires
  a per-file alias table in tsconfig plus a rewritten 320-entry export map and
  a changed dist layout; every future SDK file needs three registrations.
  Rejected: permanent bookkeeping to preserve what the flat dir gives for free.
- **Group into subdirs and change the public specifiers**
  (`openclaw/plugin-sdk/transport/x`) — rewrites ~600 extension imports and
  breaks any out-of-tree plugin. Rejected: public-surface churn for zero
  functional gain.

## Consequences

- Easier: extensions and the export map stay untouched; the SDK surface stays
  greppable by exact subpath.
- Harder: plugin-sdk is a permanent exception to the ≤80-files rule and must
  be listed in the ratchet's grandfather list with a pointer to this ADR.
