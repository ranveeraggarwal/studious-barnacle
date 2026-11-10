# E2E Test Suite Readiness Report (`TEST_READY.md`)

- **Status**: `READY`
- **Track**: E2E Testing Track (`sub_orch_e2e`) & Milestone M4 Phase 2 (`sub_orch_m4_phase2`)
- **Runner**: `@playwright/test` with headless Chromium (`/usr/lib/chromium/chromium` + ANGLE SwiftShader WebGL) & `vitest`
- **Config File**: `tests/e2e/playwright.e2e.config.ts`
- **Total Discovered E2E Tests**: `89` (`79` across Tiers 1–4 + `10` across Tier 5)
- **Total Unit Tests**: `75` (`44` across M1–M3 + `31` in Tier 5 `tests/unit/adversarial.test.ts`)

## 1. Execution & Discovery Commands

```bash
# List and verify all E2E tests (syntax, imports, and test count check)
npx playwright test --list --config=tests/e2e/playwright.e2e.config.ts

# Run the complete E2E suite (Tiers 1–5, 89 tests) against the application
npx playwright test --config=tests/e2e/playwright.e2e.config.ts

# Run the complete Vitest unit & white-box adversarial test suite (75 tests)
npm run test:unit
```

## 2. Test Suite Breakdown by Tier

| Tier | Spec File | Required Min | Implemented | Scope & Coverage |
|---|---|---|---|---|
| **Tier 1** | `tests/e2e/tier1-features.spec.ts` | `≥30` (`≥5`/feature) | `30` | Core feature verification across `F1`–`F6` (`5` tests per feature) |
| **Tier 2** | `tests/e2e/tier2-boundaries.spec.ts` | `≥30` (`≥5`/feature) | `30` | Boundary & corner cases across `F1`–`F6`, explicitly covering `EC1`–`EC7` |
| **Tier 3** | `tests/e2e/tier3-combinations.spec.ts` | `≥10` | `12` | Cross-feature pairwise & multi-feature interactions (`T3-01`–`T3-12`) |
| **Tier 4** | `tests/e2e/tier4-scenarios.spec.ts` | `≥6` | `7` | Real-world multi-step user journeys & stress invariants (`T4-01`–`T4-07`) |
| **Tier 5** | `tests/e2e/tier5-adversarial.spec.ts` | `10` | `10` | White-box adversarial E2E coverage (`T5-01`–`T5-10`) across input ref-counting, fallback paths, deferred render flush, rim slosh spill, and `MAX_PARTICLES` pruning |
| **Total E2E** | **All 5 Spec Files** | **`≥86`** | **`89`** | **100% Feature (`F1`–`F6`), Edge Case (`EC1`–`EC7`) & White-Box Adversarial E2E Coverage** |
| **Tier 5 Unit** | `tests/unit/adversarial.test.ts` | — | `31` (`75` total unit) | White-box unit tests (`UT-ADV-01`..`06`, `U5-1`..`5`) covering shader/FBO rollbacks, WebGL1 half-float, `SpatialHash` growth, `ColorMixer` >2048 growth, and `WB-BUG-01`..`03` |

## 3. Feature & Edge-Case Traceability Matrix

| Feature / Edge Case | Tier 1 Tests | Tier 2 Tests | Tier 3 Tests | Tier 4 Scenarios | Tier 5 Adversarial |
|---|---|---|---|---|---|
| **F1**: Minimal Website & WebGL2/WebGL1 Multi-Pass Canvas | `T1-F1-01`..`05` | `T2-F1-01`..`05` | `T3-08`, `T3-10`, `T3-12` | `T4-01`, `T4-03`, `T4-07` | `T5-05`, `T5-08`, `T5-10` + `U5-1`..`U5-3` |
| **F2**: Soda Fountain & Multi-Drink Dispenser Controls | `T1-F2-01`..`05` | `T2-F2-01`..`05` | `T3-01`..`T3-09`, `T3-11`, `T3-12` | `T4-01`..`T4-07` | `T5-01`, `T5-03`, `T5-04`, `T5-06` + `U5-4` |
| **F3**: Pouring Fluid Stream & 2D SPH Physics Engine | `T1-F3-01`..`05` | `T2-F3-01`..`05` | `T3-01`, `T3-03`, `T3-05`, `T3-06`, `T3-10` | `T4-01`..`T4-07` | `T5-07`, `T5-09` + `UT-ADV-02`, `UT-ADV-05` |
| **F4**: Interactive Movable Glass Container | `T1-F4-01`..`05` | `T2-F4-01`..`05` | `T3-02`..`T3-05`, `T3-07`, `T3-08`, `T3-10`..`T3-12` | `T4-01`..`T4-07` | `T5-02`, `T5-03`, `T5-05`, `T5-10` + `UT-ADV-03` |
| **F5**: Fluid-Glass Containment, Sloshing, Overflow & Reset | `T1-F5-01`..`05` | `T2-F5-01`..`05` | `T3-02`..`T3-07`, `T3-10`..`T3-12` | `T4-01`..`T4-07` | `T5-02`, `T5-07`, `T5-08`, `T5-09` + `UT-ADV-03` |
| **F6**: Dynamic Multi-Drink Color Mixing & Blending | `T1-F6-01`..`05` | `T2-F6-01`..`05` | `T3-01`, `T3-02`, `T3-04`..`T3-10`, `T3-12` | `T4-01`..`T4-07` | `T5-01`..`T5-03` + `UT-ADV-01`, `UT-ADV-04` |
| **EC1–EC7**: Off-button release, rapid switch, overfill, stream miss, high-speed drag, pointercancel/blur, resize | — | Covered in `tier2-boundaries.spec.ts` | Combined in `T3-05`, `T3-07`, `T3-08`, `T3-11` | Combined in `T4-03`, `T4-04`, `T4-07` | Extended in `T5-01`..`T5-10` + `adversarial.test.ts` |
