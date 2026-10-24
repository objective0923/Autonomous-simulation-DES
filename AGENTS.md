# Development guidance

- Each cloud task is isolated. Use the existing checkout; do not create a Git worktree unless the user requests one.
- Install with `uv sync --frozen` and `npm ci`. Validate Python engine changes with `npm run test:api` and planning/model changes with `npm test`; validate UI/type integration with `npm run build` and `npm run test:e2e` on Linux x64.
- `npm run simulate -- --benchmarks` exercises the documented baseline scenarios without rendering.
- Python SimPy owns simulation state, time, inventory, energy, and KPIs. Never derive them from frame counts or UI playback time.
- Internal units are m, s, kg, Wh, W. Seed random streams by source ID; never use `Math.random` for model calculations.
- Preserve schema/version metadata, finite inventory reservations, and shared bidirectional physical corridor locks.
- Record model assumptions and incomplete requirements in docs. Do not claim physical safety verification or real equipment integration.
- Keep generated results in ignored `artifacts/`; do not commit caches, browser binaries, node_modules, or credentials.
