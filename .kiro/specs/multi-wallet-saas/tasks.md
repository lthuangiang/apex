# Implementation Plan: Multi-Wallet SaaS Platform

## Overview

Transform APEX from a single-operator system into a multi-tenant platform by introducing a wallet-scoped layer between the HTTP session and the existing `BotManager`. The implementation adds `TenantRegistry`, `TenantContext`, and `TenantConfigStore` classes, refactors `DashboardServer` to use wallet-scoped middleware, and adds startup restoration and admin stats. All existing `BotManager`, `BotInstance`, `HedgeBot`, and adapter code is reused without modification.

## Tasks

- [x] 1. Create TenantConfigStore
  - [x] 1.1 Implement `src/bot/TenantConfigStore.ts`
    - Create class with `configPath: string` readonly property derived from `dataDir`
    - Implement `load(): (BotConfig | HedgeBotConfig)[]` — reads `{dataDir}/bot-configs.json`, returns `[]` if file missing, uses existing `loadBotConfigs` parsing logic (JSON parse + validate loop)
    - Implement `save(configs: (BotConfig | HedgeBotConfig)[]): void` — wraps `saveBotConfigsToFile` logic with atomic write: write to `configPath + '.tmp'`, then `fs.renameSync` to final path
    - Sanitize `tradeLogPath` on save: rewrite any path that does not resolve within `dataDir` to use only `path.basename(config.tradeLogPath)` within `dataDir`
    - Ensure `dataDir` exists (`fs.mkdirSync(dataDir, { recursive: true })`) in constructor
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 1.2 Write property test for TenantConfigStore config round-trip
    - **Property 3: Config round-trip** — for any valid `BotConfig` array, `save(configs)` followed by `load()` returns an equivalent array (same IDs, same fields)
    - **Validates: Requirements 6.2, 6.3**
    - Covered in `src/bot/__tests__/TenantConfigStore.property.test.ts` (Properties 6a, 6b, 6c)

  - [x] 1.3 Write unit tests for TenantConfigStore edge cases
    - Test `load()` returns `[]` when file does not exist (Requirement 6.3)
    - Test atomic write: verify `.tmp` file is cleaned up after successful save
    - Test path sanitization: a config with `tradeLogPath: '../../evil.json'` is rewritten to `{dataDir}/evil.json`
    - _Requirements: 6.2, 6.3, 6.4, 6.5_
    - Covered in `src/bot/__tests__/TenantConfigStore.property.test.ts`

- [x] 2. Create TenantContext
  - [x] 2.1 Implement `src/bot/TenantContext.ts`
    - Create class with readonly properties: `walletAddress: string`, `dataDir: string`, `botManager: BotManager`, `configStore: TenantConfigStore`
    - Constructor accepts `{ walletAddress, dataDir, botManager, configStore }` — normalizes `walletAddress` to lowercase
    - Implement `persistConfigs(): void` — calls `configStore.save(botManager.getAllBots().map(b => b.config))`
    - Implement `loadConfigs(telegram: TelegramManager): Promise<void>` — loads configs via `configStore.load()`, creates bot instances via `botManager.createBot` / `botManager.createHedgeBot`, sets `tradeLogPath` to `path.join(dataDir, path.basename(config.tradeLogPath))`
    - Implement `shutdown(): Promise<void>` — stops all running bots (`botManager.getAllBots()` → filter `RUNNING` → `bot.stop()`), then calls `persistConfigs()`
    - _Requirements: 3.1, 3.7, 5.2, 5.8_

  - [-] 2.2 Write unit tests for TenantContext
    - Test `shutdown()` stops all running bots and calls `persistConfigs()` (mock BotManager)
    - Test `walletAddress` is always stored lowercase regardless of input case
    - Test `loadConfigs()` sets `tradeLogPath` within `dataDir` for each loaded config
    - _Requirements: 3.7, 5.2_

- [x] 3. Create TenantRegistry
  - [x] 3.1 Implement `src/bot/TenantRegistry.ts`
    - Create class with private `registry = new Map<string, TenantContext>()`
    - Constructor accepts `dataBaseDir: string`
    - Implement `ensureTenant(walletAddress: string): TenantContext` — normalize to lowercase, return existing if present, otherwise create `dataDir`, new `BotManager`, new `TenantConfigStore`, new `TenantContext`, store in registry, return
    - Implement `getTenant(walletAddress: string): TenantContext | undefined` — lowercase lookup
    - Implement `listTenants(): string[]` — return `Array.from(registry.keys())`
    - Implement `shutdownAll(): Promise<void>` — call `tenant.shutdown()` on all entries
    - Implement `getPlatformStats(): PlatformStats` — aggregate across all tenants: `totalTenants`, `activeTenants` (≥1 RUNNING bot), `totalBots`, `activeBots`, `totalVolumeUsd`, `totalPnlUsd`
    - _Requirements: 1.1, 1.2, 3.1, 3.2, 3.6, 9.1, 9.5_

  - [x] 3.2 Write property test for TenantRegistry isolation
    - **Property 1: Tenant isolation** — for any two distinct wallet addresses `A` and `B`, `ensureTenant(A).botManager !== ensureTenant(B).botManager`
    - **Validates: Requirements 1.1, 1.2**
    - Covered in `src/bot/__tests__/TenantRegistry.test.ts`

  - [x] 3.3 Write property test for TenantRegistry idempotency
    - **Property 2: Idempotent tenant creation** — `ensureTenant(addr) === ensureTenant(addr)` (same object reference on repeated calls)
    - **Validates: Requirements 3.2**
    - Covered in `src/bot/__tests__/TenantRegistry.test.ts`

  - [x] 3.4 Write property test for address normalization
    - **Property 4: Address normalization** — for any mixed-case wallet address string, `ensureTenant(addr).walletAddress === addr.toLowerCase()`
    - **Validates: Requirements 2.9, 7.5**
    - Covered in `src/bot/__tests__/TenantRegistry.property.test.ts`

  - [x] 3.5 Write unit tests for TenantRegistry
    - Test `shutdownAll()` calls `shutdown()` on every registered tenant
    - Test `getPlatformStats()` counts active tenants correctly (only those with ≥1 RUNNING bot)
    - Test invalid wallet directory names are not loaded during startup scan
    - _Requirements: 3.6, 9.1, 9.5_
    - Covered in `src/bot/__tests__/TenantRegistry.test.ts`

- [x] 4. Checkpoint — Core tenant classes complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Add walletScopedMiddleware and refactor DashboardServer
  - [x] 5.1 Add `walletScopedMiddleware` to `src/dashboard/server.ts`
    - Add `TenantRegistry` field to `DashboardServer` class
    - Add `registerTenantRegistry(registry: TenantRegistry): void` method
    - Implement `walletScopedMiddleware` as a private arrow function: extract `siwe_token` from cookies, look up in `validTokens` (check expiry, delete if expired → 401), look up wallet in `validTokenAddresses` (missing → 401), call `tenantRegistry.ensureTenant(walletAddress)`, attach `req.walletAddress` and `req.tenant` to request, call `next()`
    - Extend the `Request` type locally with `walletAddress: string` and `tenant: TenantContext` (use module augmentation or cast)
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 10.3, 10.4_

  - [-] 5.2 Write property test for walletScopedMiddleware session-wallet binding
    - **Property 5: Session-wallet binding** — for any valid `siwe_token` in `validTokenAddresses`, the middleware attaches the exact wallet address that was stored during auth verify, never a different address
    - **Validates: Requirements 4.5, 10.2**
    - Mock `validTokens` and `validTokenAddresses` maps; generate random token/address pairs with `fc.hexaString`

  - [x] 5.3 Refactor `_setupManagerRoutes()` in `src/dashboard/server.ts`
    - Apply `walletScopedMiddleware` to all `/api/bots/*` routes
    - Replace all `this.botManager` references in bot routes with `(req as WalletScopedRequest).tenant.botManager`
    - Update `POST /api/bots` to scope `tradeLogPath` to `req.tenant.dataDir` before creating the bot
    - Update `POST /api/bots` to call `req.tenant.persistConfigs()` after bot creation
    - Update `POST /api/bots/:id/start`, `POST /api/bots/:id/stop`, `DELETE /api/bots/:id` to use `req.tenant.botManager` and call `req.tenant.persistConfigs()` on state changes
    - Update `GET /api/bots` and `GET /api/bots/stats` to use `req.tenant.botManager`
    - _Requirements: 4.1, 4.3, 4.4, 5.1, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9_

  - [x] 5.4 Write unit tests for wallet-scoped bot routes
    - Test `GET /api/bots` returns 401 with no cookie
    - Test `GET /api/bots` returns 401 with expired token
    - Test `POST /api/bots` creates bot in tenant's BotManager, not a global one
    - Test `DELETE /api/bots/:id` on a running bot returns 409
    - Test `GET /api/bots/:id` for non-existent bot returns 404
    - _Requirements: 4.1, 4.2, 5.3, 5.6, 5.9_
    - Covered in `src/dashboard/__tests__/wallet-scoped-routes.test.ts`

- [x] 6. Update auth verify to eagerly create tenant
  - [x] 6.1 Update `POST /api/auth/verify` in `src/dashboard/server.ts`
    - After `validTokenAddresses.set(token, result.address!)`, call `this.tenantRegistry?.ensureTenant(result.address!)` to eagerly create the tenant context on first login
    - This ensures `./data/{walletAddr}/` exists before the first API call
    - _Requirements: 3.1, 7.1_

  - [x] 6.2 Write unit tests for auth verify tenant creation
    - Test that a successful SIWE verify triggers `ensureTenant` on the registry
    - Test that the tenant's data directory is created on first login
    - _Requirements: 3.1, 7.1_
    - Covered in `src/dashboard/__tests__/auth-verify-tenant.test.ts`

- [x] 7. Implement startup tenant restoration
  - [x] 7.1 Implement `restoreTenantsOnStartup()` in `src/bot/TenantRegistry.ts`
    - Add method `restoreAll(telegram: TelegramManager): Promise<number>`
    - Create `./data/` if it does not exist; return 0 if empty
    - Read subdirectories with `fs.readdirSync`, filter by `/^0x[a-f0-9]{40}$/` (skip invalid names)
    - For each valid wallet dir: check for `bot-configs.json`, skip if missing
    - Call `ensureTenant(walletDir)` to get/create context
    - Call `tenant.loadConfigs(telegram)` — this creates bot instances
    - For each bot with `autoStart: true`: call `bot.start()` in a try/catch; log errors but continue
    - Return count of successfully restored tenants
    - _Requirements: 3.3, 3.4, 3.5, 7.4, 11.5_

  - [x] 7.2 Write unit tests for startup restoration
    - Test that wallets with `bot-configs.json` are restored
    - Test that directories not matching `/^0x[a-f0-9]{40}$/` are skipped
    - Test that a bot failing `autoStart` does not block other tenants from restoring
    - Test that a malformed `bot-configs.json` is skipped without crashing
    - _Requirements: 3.3, 3.4, 3.5, 7.4, 11.5_
    - Covered in `src/bot/__tests__/TenantRegistry.startup.test.ts`

- [x] 8. Add admin stats endpoint
  - [x] 8.1 Add admin authentication middleware and `GET /api/admin/stats` to `src/dashboard/server.ts`
    - Read `ADMIN_TOKEN` from `process.env.ADMIN_TOKEN`
    - Implement `adminAuthMiddleware`: check `Authorization: Bearer <token>` header against `ADMIN_TOKEN`; also reject any request that only has a `siwe_token` cookie (wallet sessions must not grant admin access); return 401 if not authorized
    - Register `GET /api/admin/stats` with `adminAuthMiddleware`: call `this.tenantRegistry!.getPlatformStats()` and return the result as JSON
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

  - [x] 8.2 Write unit tests for admin endpoint
    - Test `GET /api/admin/stats` returns 401 with no token
    - Test `GET /api/admin/stats` returns 401 when only `siwe_token` cookie is present
    - Test `GET /api/admin/stats` returns 200 with correct `Authorization: Bearer` header
    - Test returned stats shape matches `PlatformStats` interface
    - _Requirements: 9.1, 9.2, 9.3, 9.4_
    - Covered in `src/dashboard/__tests__/adminStats.test.ts`

- [x] 9. Add path traversal validation utility
  - [x] 9.1 Implement `assertWithinDataDir(filePath: string, dataDir: string): void` in `src/bot/TenantConfigStore.ts` (or a shared util)
    - Use `path.resolve(filePath)` and check it starts with `path.resolve(dataDir)`
    - Throw an error if the resolved path escapes `dataDir`
    - Call this guard in `TenantConfigStore.save()` before any file write
    - _Requirements: 7.2, 7.3_

  - [x] 9.2 Write property test for path containment
    - **Property 6: Path containment** — for any bot config created via the API, `tradeLogPath` always resolves within the tenant's `dataDir` after `persistConfigs()`
    - **Validates: Requirements 5.2, 7.2, 7.3**
    - Covered in `src/bot/__tests__/TenantConfigStore.property.test.ts`

- [x] 10. Checkpoint — All new components wired together
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Wire TenantRegistry into server startup in `src/bot.ts` (or equivalent entry point)
  - [x] 11.1 Update the application entry point to instantiate and wire TenantRegistry
    - Instantiate `TenantRegistry` with `'./data'` as the base directory
    - Call `tenantRegistry.restoreAll(telegram)` before `server.listen()`
    - Call `server.registerTenantRegistry(tenantRegistry)` so the dashboard server can use it
    - Register a `process.on('SIGTERM', ...)` / `process.on('SIGINT', ...)` handler that calls `tenantRegistry.shutdownAll()` before exit
    - _Requirements: 3.3, 3.4, 3.6_
    - Implemented in `src/bot.ts` for both multi-bot and single-bot modes

  - [x] 11.2 Write integration test for full tenant lifecycle
    - Test: new wallet authenticates → `ensureTenant` creates context → `POST /api/bots` creates bot in tenant's manager → `GET /api/bots` returns only that wallet's bots → second wallet creates bot with same ID → each wallet sees only their own bot
    - **Property: Data isolation** — two wallets with the same bot ID never see each other's bots
    - **Validates: Requirements 1.4, 1.5**
    - Use supertest for HTTP-level testing
    - File: `src/dashboard/__tests__/tenant-lifecycle.integration.test.ts`

- [ ] 12. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `[-]` are optional and can be skipped for faster MVP
- `BotManager`, `BotInstance`, `HedgeBot`, and all exchange adapters are unchanged
- `walletScopedMiddleware` reads wallet identity exclusively from `validTokenAddresses` (set during SIWE verify) — never from request body or URL params
- Admin token is read from `process.env.ADMIN_TOKEN`; if unset, admin endpoints return 503
- The `./data/` directory is the single root for all tenant data; Docker volumes should mount this path
- Property tests use `fast-check` v4 (already in devDependencies); unit tests use `vitest`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.2", "3.1"] },
    { "id": 2, "tasks": ["3.2", "3.3", "3.4", "3.5", "5.1", "9.1"] },
    { "id": 3, "tasks": ["5.2", "5.3", "6.1", "7.1", "9.2"] },
    { "id": 4, "tasks": ["5.4", "6.2", "7.2", "8.1"] },
    { "id": 5, "tasks": ["8.2", "11.1"] },
    { "id": 6, "tasks": ["11.2"] }
  ]
}
```
