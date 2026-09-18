# Retained legacy optimizer snapshots

The checked-in optimizer trajectories predate the cinematic environment and
prompt upgrade. They are retained for historical inspection, not presented as
solutions for the updated scenes. The environment manifest marks them stale;
automatic visualizer replay uses the independent authored reference instead.

Regenerate a specific example from the repository root:

```bash
npm run generate:trajectories -- --example example-01 --iterations 20
```

A new export receives source/trajectory fingerprints and updates its manifest
entry. Re-run the semantic audit/benchmark to assess quality; freshness alone
never implies a good solution. The reference benchmark rejects mismatched or
missing provenance unless `--allow-stale` is explicitly supplied for historical
diagnostics. See `docs/REFERENCE_PROTOCOL.md` and `docs/CINEMATIC_UPGRADE.md`.
