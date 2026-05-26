# Requirements Document

## Introduction

The multi-wallet SaaS feature transforms APEX/DRIFT from a single-operator trading bot dashboard into a multi-tenant platform. Each Solana/EVM wallet address becomes an independent tenant with fully isolated bots, configurations, trade history, state, and PnL. The existing SIWE (Sign-In with Ethereum) authentication flow is extended to scope all data and bot operations per authenticated wallet. A single server instance serves all tenants; tenants self-serve through the dashboard without any cross-tenant data visibility.

## Glossary

- **Tenant**: A wallet address that has authenticated via SIWE and owns an isolated set of bots and data.
- **TenantRegistry**: The in-memory registry that maps wallet addresses to their `TenantContext` instances.
- **TenantContext**: The per-wallet container that owns a `BotManager`, config store, and data directory.
- **BotManager**: The existing class that manages the lifecycle of bot instances for a single tenant.
- **BotInstance**: The existing class representing a single running or stopped trading bot.
- **SIWE**: Sign-In with Ethereum (EIP-4361) — the wallet-based authentication protocol already implemented in `SiweAuth.ts`.
- **siwe_token**: The HTTP-only session cookie issued after successful SIWE verification.
- **WalletScopedRouter**: The Express middleware layer that resolves the authenticated wallet from the session cookie and attaches the correct `TenantContext` to each request.
- **TenantConfigStore**: The per-tenant config persistence component that reads and writes `bot-configs.json` within the tenant's data directory.
- **DataDir**: The per-tenant filesystem directory at `./data/{walletAddress}/` that stores all tenant-owned files.
- **Platform Operator**: The person who runs the server instance and has access to admin endpoints.
- **Admin**: The platform operator authenticated via a separate admin token (not a wallet session).
- **credentialKey**: A reference to an environment variable holding exchange API credentials (e.g., `DECIBELS_PRIVATE_KEY`).
- **autoStart**: A bot config flag indicating the bot should be automatically started when the server restarts.
- **PnL**: Profit and Loss — the net financial result of a bot's trading activity.

---

## Requirements

### Requirement 1: Tenant Isolation

**User Story:** As a wallet owner, I want my bots, configurations, and trade history to be completely isolated from other wallets, so that no other user can see or affect my trading activity.

#### Acceptance Criteria

1. THE TenantRegistry SHALL maintain a separate TenantContext for each distinct wallet address.
2. WHEN two distinct wallet addresses are registered, THE TenantRegistry SHALL ensure their BotManager instances are different objects (never shared).
3. WHEN a bot is created for wallet A, THE System SHALL store its trade log exclusively within `./data/{walletA}/` and never within any other wallet's data directory.
4. WHEN wallet A calls `GET /api/bots`, THE WalletScopedRouter SHALL return only the bots owned by wallet A.
5. WHEN wallet A calls `GET /api/bots`, THE WalletScopedRouter SHALL never include bots owned by wallet B in the response, even if wallet B has a bot with the same ID.
6. AFTER `TenantConfigStore.save()` is called for wallet A, THE TenantConfigStore SHALL ensure that loading the config file for wallet B never returns bots owned by wallet A.

---

### Requirement 2: Wallet Authentication and Session Management

**User Story:** As a wallet owner, I want to sign in using my Ethereum wallet via SIWE, so that I can access my personal dashboard without a password.

#### Acceptance Criteria

1. WHEN a client requests `GET /api/auth/nonce`, THE System SHALL return a unique, single-use nonce that expires after 5 minutes.
2. WHEN a client submits a valid SIWE message and signature to `POST /api/auth/verify`, THE System SHALL verify the signature using `verifySiweMessage()` and issue a `siwe_token` session cookie.
3. WHEN `verifySiweMessage()` succeeds, THE System SHALL set the `siwe_token` cookie with `HttpOnly` and `SameSite=Lax` attributes and a 24-hour TTL.
4. WHEN `verifySiweMessage()` fails, THE System SHALL return HTTP 401 with a descriptive error message and SHALL NOT issue a session cookie.
5. WHEN a client submits a SIWE message with an already-used nonce, THE System SHALL reject the request with HTTP 401.
6. WHEN a client submits a SIWE message with an `issuedAt` timestamp older than 10 minutes, THE System SHALL reject the request with HTTP 401.
7. WHEN a client calls `POST /api/auth/logout`, THE System SHALL delete the `siwe_token` from the valid token store, rendering the session immediately invalid.
8. WHEN a client sends a `siwe_token` cookie that has been deleted via logout, THE WalletScopedRouter SHALL return HTTP 401.
9. THE System SHALL normalize all wallet addresses to lowercase before using them as tenant keys.

---

### Requirement 3: Tenant Context Lifecycle

**User Story:** As a wallet owner, I want my tenant context to be created automatically on first login and restored on server restart, so that my bots and configurations persist across sessions.

#### Acceptance Criteria

1. WHEN `TenantRegistry.ensureTenant(walletAddress)` is called for the first time for a given address, THE TenantRegistry SHALL create a new TenantContext, create the `./data/{walletAddress}/` directory, and store the context in the registry.
2. WHEN `TenantRegistry.ensureTenant(walletAddress)` is called again with the same address, THE TenantRegistry SHALL return the same TenantContext object (identity equality) without creating a new directory or overwriting existing data.
3. WHEN the server starts and `./data/` contains subdirectories with valid wallet address names, THE System SHALL restore a TenantContext for each such wallet that has a `bot-configs.json` file.
4. WHEN restoring tenants on startup, THE System SHALL auto-start all bots whose config has `autoStart: true`.
5. WHEN a bot fails to auto-start during server restoration, THE System SHALL log the error and continue restoring other bots and tenants without interruption.
6. WHEN `TenantRegistry.shutdownAll()` is called, THE TenantRegistry SHALL call `shutdown()` on every registered TenantContext.
7. WHEN `TenantContext.shutdown()` is called, THE TenantContext SHALL stop all running bots and call `persistConfigs()` before returning.

---

### Requirement 4: Wallet-Scoped API Routing

**User Story:** As a wallet owner, I want all API calls I make to automatically operate on my own bots and data, so that I never accidentally affect another wallet's bots.

#### Acceptance Criteria

1. WHEN a request arrives at any `/api/bots/*` endpoint without a valid `siwe_token` cookie, THE WalletScopedRouter SHALL return HTTP 401 and SHALL NOT call the route handler.
2. WHEN a request arrives with a `siwe_token` cookie that has expired, THE WalletScopedRouter SHALL return HTTP 401 and remove the token from the valid token store.
3. WHEN a request arrives with a valid `siwe_token` cookie, THE WalletScopedRouter SHALL resolve the wallet address, call `TenantRegistry.ensureTenant()`, and attach the resulting TenantContext to the request object before calling the route handler.
4. THE System SHALL scope all bot CRUD, start, stop, config update, trade history, and PnL endpoints to the authenticated wallet's TenantContext.
5. WHEN a wallet-scoped request is processed, THE WalletScopedRouter SHALL use the wallet address from the `validTokenAddresses` map (set during auth verify) and SHALL NOT accept a wallet address from the request body or URL parameters as the tenant identity.

---

### Requirement 5: Per-Wallet Bot Management

**User Story:** As a wallet owner, I want to create, start, stop, and delete bots that are scoped to my wallet, so that I can manage my trading strategies independently.

#### Acceptance Criteria

1. WHEN a wallet owner calls `POST /api/bots` with a valid bot config, THE System SHALL create the bot within the authenticated wallet's BotManager and return HTTP 201 with the bot status.
2. WHEN a bot is created, THE System SHALL set the bot's `tradeLogPath` to `./data/{walletAddress}/trades-{botId}.json`, scoped to the tenant's data directory.
3. WHEN a wallet owner calls `POST /api/bots` with a bot ID that already exists in their BotManager, THE System SHALL return HTTP 409 with an error message.
4. WHEN a wallet owner calls `POST /api/bots/{botId}/start`, THE System SHALL start the bot within the authenticated wallet's BotManager and return HTTP 200.
5. WHEN a wallet owner calls `POST /api/bots/{botId}/stop`, THE System SHALL stop the bot within the authenticated wallet's BotManager and return HTTP 200.
6. WHEN a wallet owner calls `DELETE /api/bots/{botId}` for a running bot, THE System SHALL return HTTP 409 and SHALL NOT remove the bot.
7. WHEN a wallet owner calls `DELETE /api/bots/{botId}` for a stopped bot, THE System SHALL remove the bot from the BotManager and persist the updated config.
8. WHEN a bot is created, started, stopped, or deleted, THE System SHALL call `TenantContext.persistConfigs()` to write the updated config to disk.
9. WHEN a wallet owner calls `GET /api/bots/{botId}` for a bot ID that does not exist in their BotManager, THE System SHALL return HTTP 404.

---

### Requirement 6: Per-Tenant Config Persistence

**User Story:** As a wallet owner, I want my bot configurations to be saved to disk automatically, so that my bots are restored correctly after a server restart.

#### Acceptance Criteria

1. THE TenantConfigStore SHALL store bot configurations at `./data/{walletAddress}/bot-configs.json`.
2. WHEN `TenantConfigStore.save()` is called, THE TenantConfigStore SHALL write to a temporary file first and then atomically rename it to the final path, preventing partial writes.
3. WHEN `TenantConfigStore.load()` is called and no config file exists, THE TenantConfigStore SHALL return an empty array without throwing an error.
4. WHEN `TenantConfigStore.save()` is called, THE TenantConfigStore SHALL ensure all `tradeLogPath` values in the saved configs resolve within the tenant's `./data/{walletAddress}/` directory.
5. WHEN `TenantConfigStore.save()` is called, THE TenantConfigStore SHALL rewrite any `tradeLogPath` that does not resolve within the tenant's data directory to use only the filename component within that directory.

---

### Requirement 7: Data Directory and Path Safety

**User Story:** As a platform operator, I want all tenant file operations to be strictly contained within each wallet's data directory, so that no tenant can read or write files outside their own namespace.

#### Acceptance Criteria

1. THE System SHALL create the `./data/{walletAddress}/` directory when a TenantContext is first created, using `fs.mkdirSync` with `{ recursive: true }`.
2. WHEN any file path is constructed for a tenant operation, THE System SHALL validate that the resolved path starts with the tenant's `dataDir` prefix before performing the file operation.
3. IF a constructed file path resolves outside the tenant's `dataDir`, THEN THE System SHALL reject the operation and return an error without performing any file I/O.
4. WHEN scanning `./data/` for tenant directories on startup, THE System SHALL skip any directory whose name does not match the pattern `/^0x[a-f0-9]{40}$/` (lowercase hex wallet address).
5. THE System SHALL normalize wallet address directory names to lowercase when creating or resolving tenant data directories.

---

### Requirement 8: Wallet-Aware Dashboard UI

**User Story:** As a wallet owner, I want the dashboard to display my connected wallet address and show only my bots, so that I always know which account I am operating.

#### Acceptance Criteria

1. WHEN a wallet owner accesses the dashboard, THE Dashboard SHALL display the authenticated wallet address in the navigation header.
2. WHEN a wallet owner accesses the dashboard, THE Dashboard SHALL display only the bots belonging to the authenticated wallet.
3. WHEN a wallet owner has no bots yet, THE Dashboard SHALL display an empty state with a prompt to add the first bot.
4. WHEN the dashboard makes API calls to bot management endpoints, THE Dashboard SHALL rely on the `siwe_token` cookie for authentication and SHALL NOT embed the wallet address in API request bodies as the identity source.
5. WHEN a wallet owner is not authenticated, THE Dashboard SHALL redirect to the wallet login page.

---

### Requirement 9: Admin Platform Visibility

**User Story:** As a platform operator, I want to view aggregate statistics across all tenants, so that I can monitor platform health and usage.

#### Acceptance Criteria

1. THE System SHALL expose a `GET /api/admin/stats` endpoint that returns platform-wide statistics including total tenants, active tenants, total bots, active bots, total volume (USD), and total PnL (USD).
2. WHEN a request is made to any `/api/admin/*` endpoint without a valid admin token, THE System SHALL return HTTP 401.
3. THE System SHALL protect admin endpoints with a separate admin authentication mechanism that is distinct from the wallet session (`siwe_token`) cookie.
4. WHEN a wallet owner's `siwe_token` is used to access `/api/admin/*`, THE System SHALL return HTTP 401 and SHALL NOT grant admin access.
5. THE System SHALL compute active tenant count as the number of tenants with at least one bot in `RUNNING` status.

---

### Requirement 10: Session Security

**User Story:** As a platform operator, I want session tokens to be cryptographically secure and bound to a specific wallet address, so that sessions cannot be forged or transferred between wallets.

#### Acceptance Criteria

1. THE System SHALL generate session tokens as 64 hexadecimal characters (32 random bytes) using a cryptographically secure random number generator.
2. WHEN a session token is issued, THE System SHALL store the mapping from token to wallet address in the `validTokenAddresses` map, which is populated only by the SIWE verification flow.
3. THE System SHALL check token expiry on every authenticated request and SHALL NOT serve requests with expired tokens.
4. WHEN a session token expires, THE System SHALL remove it from the `validTokens` store on the next access attempt.
5. IF a `siwe_token` cookie is present but the token has no corresponding wallet address in `validTokenAddresses`, THEN THE WalletScopedRouter SHALL return HTTP 401.
6. THE System SHALL set session tokens to expire 24 hours after issuance.

---

### Requirement 11: Graceful Error Handling

**User Story:** As a wallet owner, I want the system to handle errors gracefully and return clear error messages, so that I understand what went wrong and can take corrective action.

#### Acceptance Criteria

1. WHEN a wallet owner calls `GET /api/bots` and has no bots, THE System SHALL return HTTP 200 with an empty array.
2. WHEN a bot creation request references a `credentialKey` that does not correspond to a valid environment variable, THE System SHALL return HTTP 400 with a descriptive error message.
3. WHEN a bot operation (start, stop, create) fails due to an internal error, THE System SHALL return HTTP 500 with an error message and SHALL log the error server-side.
4. WHEN a request targets a bot ID that does not exist in the authenticated wallet's BotManager, THE System SHALL return HTTP 404.
5. IF a tenant's `bot-configs.json` is malformed or unreadable during server startup restoration, THEN THE System SHALL log the error and skip that tenant without crashing the server.
