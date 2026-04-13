# Tasks: dashboard-config-override

## Phase 1: ConfigStore and Validation

- [x] 1.1 Create `src/config/ConfigStore.ts` with `OverridableConfig` type, in-memory override map, `getEffective()`, `applyOverrides()`, and `resetToDefaults()` methods
- [x] 1.2 Create `src/config/validateOverrides.ts` with pure `validateOverrides(patch, effective)` function covering all validation rules from Requirements 3
- [x] 1.3 Add file persistence to `ConfigStore`: `saveToDisk()` called after every `applyOverrides` / `resetToDefaults`, and `loadFromDisk()` that handles missing file, invalid JSON, and per-field validation failures (Requirements 6)
- [x] 1.4 Wire `ConfigStore.loadFromDisk()` into `src/bot.ts` startup, before the first bot tick

## Phase 2: API Routes

- [x] 2.1 Add `GET /api/config` route to `DashboardServer._setupRoutes` — returns `configStore.getEffective()` as JSON (Requirements 1)
- [x] 2.2 Add `POST /api/config` route — validates body with `validateOverrides`, applies via `configStore.applyOverrides`, returns 200 with effective config or 400 with errors (Requirements 2, 3)
- [x] 2.3 Add `DELETE /api/config` route — calls `configStore.resetToDefaults`, returns 200 with base config (Requirements 4)
- [x] 2.4 Pass `configStore` instance into `DashboardServer` (constructor or `setConfigStore` method)

## Phase 3: Dashboard UI Panel

- [x] 3.1 Add CSS for the Config Overrides panel to `_buildHtml` (grouped sections, input fields, Apply/Reset buttons, toast, responsive down to 320px)
- [x] 3.2 Add HTML markup for the Config Overrides panel with five labelled sections: Order Sizing, Risk Management, Farm Mode Exit Rules, Trade Mode Exit Rules, Cooldown
- [x] 3.3 Add `loadConfigPanel()` JS function that calls `GET /api/config` and populates all input fields on page load
- [x] 3.4 Add `applyConfig()` JS function that collects modified fields, calls `POST /api/config`, shows success/error toast, and re-populates fields from response
- [x] 3.5 Add `resetConfig()` JS function that calls `DELETE /api/config`, shows toast, and re-populates fields from response
- [x] 3.6 Disable Apply and Reset buttons while a request is in flight; re-enable on completion (Requirements 5.8)
- [x] 3.7 Call `loadConfigPanel()` in the page init block alongside existing `refresh()` / `refreshCtrlStatus()` calls

## Phase 4: Tests

- [x] 4.1 Write unit tests for `validateOverrides` covering all validation rules (positive numbers, percent range, cross-field range pairs, non-negative integer cooldown)
- [x] 4.2 Write unit tests for `ConfigStore` covering `getEffective` base values, `applyOverrides` partial merge, `resetToDefaults`, and `loadFromDisk` edge cases (missing file, invalid JSON, mixed valid/invalid)
- [x] 4.3 Write unit tests for API routes (`GET`, `POST`, `DELETE /api/config`) with mock `ConfigStore`, verifying HTTP status codes and response shapes including 401 for unauthenticated requests
- [x] 4.4 Write property-based tests using fast-check for all 7 correctness properties defined in design.md
  - Property 1: Effective config reflects overrides (valid partial patches)
  - Property 2: Validation rejects invalid positive-number fields (ORDER_SIZE_MIN/MAX, FARM_TP_USD)
  - Property 3: Validation rejects out-of-range percent parameters
  - Property 4: Validation rejects invalid range pairs (FARM hold secs, COOLDOWN mins)
  - Property 5: Reset always restores base config after any override sequence
  - Property 6: Persistence round-trip produces identical effective config
  - Property 7: Invalid persisted values are discarded individually, valid ones applied
