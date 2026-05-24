# resources/

Build artifacts that the Electron installer (`npm run dist`, Phase 16) copies
into the packaged app's `resources/` directory.

## `shop.db.template`

A pre-migrated, pre-seeded SQLite database produced by
`scripts/build-db-template.ts` (Phase 1, task 1.5). On first launch the main
process copies this file to `<userData>/shop.db` (Phase 16 first-run logic;
Req 14.2, 14.8).

This file is **not** checked into git — it is regenerated from
`prisma/migrations/` and `prisma/seed.ts` whenever the schema or seed
changes. Run:

```
npm run db:template
```

before `npm run dist` to refresh it. The script is intentionally not part of
`npm run build` (which only bundles renderer/main/preload code).
