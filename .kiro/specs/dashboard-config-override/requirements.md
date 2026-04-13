# Requirements Document

## Introduction

The dashboard-config-override feature allows operators to modify key trading bot configuration parameters directly from the APEX dashboard UI (mobile and desktop), without requiring SSH access to the server. This enables rapid adjustment of farm volume trading speed, risk thresholds, and cooldown behavior in real time.

## Glossary

- **Dashboard**: The APEX web-based monitoring and control UI served by `DashboardServer`
- **Config**: The runtime configuration object exported from `src/config.ts`, currently read-only at startup
- **Config_API**: The new REST API endpoint group (`/api/config`) responsible for reading and writing config overrides
- **Config_Store**: The in-memory (and optionally persisted) store that holds active config overrides, layered on top of the base `config` object
- **Operator**: An authenticated user of the Dashboard with a valid session token
- **Override**: A runtime value that supersedes the corresponding base config value without modifying the source file
- **Validation**: The process of checking that a submitted config value is within acceptable bounds before applying it
- **Farm_Mode**: Bot operating mode (`config.MODE === 'farm'`) focused on maximum trade volume
- **Trade_Mode**: Bot operating mode (`config.MODE === 'trade'`) focused on maximum profit per trade

## Requirements

### Requirement 1: Read Current Config Values

**User Story:** As an Operator, I want to view the current effective values of all overridable config parameters, so that I know the bot's active settings at a glance.

#### Acceptance Criteria

1. THE Config_API SHALL expose a `GET /api/config` endpoint that returns the current effective value of each overridable parameter.
2. WHEN an override is active for a parameter, THE Config_API SHALL return the override value rather than the base config value.
3. WHEN no override is active for a parameter, THE Config_API SHALL return the base config value from `src/config.ts`.
4. THE Config_API SHALL include the following parameters in the response: `ORDER_SIZE_MIN`, `ORDER_SIZE_MAX`, `STOP_LOSS_PERCENT`, `TAKE_PROFIT_PERCENT`, `POSITION_SL_PERCENT`, `FARM_MIN_HOLD_SECS`, `FARM_MAX_HOLD_SECS`, `FARM_TP_USD`, `FARM_SL_PERCENT`, `TRADE_TP_PERCENT`, `TRADE_SL_PERCENT`, `COOLDOWN_MIN_MINS`, `COOLDOWN_MAX_MINS`.
5. THE Config_API SHALL require a valid session token; IF the request is unauthenticated, THEN THE Config_API SHALL return HTTP 401.

---

### Requirement 2: Apply Config Overrides

**User Story:** As an Operator, I want to update one or more config parameters from the dashboard, so that I can speed up or slow down farm volume trading without restarting the bot.

#### Acceptance Criteria

1. THE Config_API SHALL expose a `POST /api/config` endpoint that accepts a JSON body containing one or more overridable parameter key-value pairs.
2. WHEN a valid override payload is received, THE Config_Store SHALL apply the new values immediately so that the running bot uses them on the next tick.
3. THE Config_API SHALL require a valid session token; IF the request is unauthenticated, THEN THE Config_API SHALL return HTTP 401.
4. WHEN a `POST /api/config` request is received with an empty body or no recognised keys, THE Config_API SHALL return HTTP 400 with a descriptive error message.
5. THE Config_API SHALL accept partial updates — only the keys present in the request body SHALL be updated; all other parameters SHALL retain their current effective values.

---

### Requirement 3: Validate Config Values

**User Story:** As an Operator, I want the system to reject invalid config values, so that I cannot accidentally misconfigure the bot and cause runaway losses.

#### Acceptance Criteria

1. WHEN a submitted `ORDER_SIZE_MIN` or `ORDER_SIZE_MAX` value is not a positive number, THEN THE Validation SHALL reject the request with HTTP 400 and a descriptive error.
2. WHEN a submitted `ORDER_SIZE_MIN` is greater than or equal to the effective `ORDER_SIZE_MAX`, THEN THE Validation SHALL reject the request with HTTP 400.
3. WHEN a submitted percent-based parameter (`STOP_LOSS_PERCENT`, `TAKE_PROFIT_PERCENT`, `POSITION_SL_PERCENT`, `FARM_SL_PERCENT`, `TRADE_TP_PERCENT`, `TRADE_SL_PERCENT`) is not a number in the range (0, 1], THEN THE Validation SHALL reject the request with HTTP 400 and a descriptive error.
4. WHEN a submitted `FARM_MIN_HOLD_SECS` is greater than or equal to the effective `FARM_MAX_HOLD_SECS`, THEN THE Validation SHALL reject the request with HTTP 400.
5. WHEN a submitted `FARM_TP_USD` is not a positive number, THEN THE Validation SHALL reject the request with HTTP 400.
6. WHEN a submitted `COOLDOWN_MIN_MINS` is greater than or equal to the effective `COOLDOWN_MAX_MINS`, THEN THE Validation SHALL reject the request with HTTP 400.
7. WHEN a submitted `COOLDOWN_MIN_MINS` or `COOLDOWN_MAX_MINS` is not a non-negative integer, THEN THE Validation SHALL reject the request with HTTP 400.
8. IF all submitted values pass validation, THEN THE Config_Store SHALL apply the overrides and THE Config_API SHALL return HTTP 200 with the full updated effective config.

---

### Requirement 4: Reset Config to Defaults

**User Story:** As an Operator, I want to reset all config overrides back to the base defaults, so that I can quickly restore the original bot behaviour.

#### Acceptance Criteria

1. THE Config_API SHALL expose a `DELETE /api/config` endpoint that clears all active overrides.
2. WHEN a `DELETE /api/config` request is received, THE Config_Store SHALL remove all overrides so that the base `src/config.ts` values become effective immediately.
3. THE Config_API SHALL require a valid session token; IF the request is unauthenticated, THEN THE Config_API SHALL return HTTP 401.
4. WHEN the reset succeeds, THE Config_API SHALL return HTTP 200 with the full base config values.

---

### Requirement 5: Dashboard UI — Config Panel

**User Story:** As an Operator, I want a config override panel in the dashboard UI, so that I can edit and apply settings from my phone or desktop without using a terminal.

#### Acceptance Criteria

1. THE Dashboard SHALL render a "Config Overrides" panel that displays an editable input field for each overridable parameter.
2. WHEN the Dashboard loads, THE Dashboard SHALL populate each input field with the current effective value returned by `GET /api/config`.
3. THE Dashboard SHALL group parameters into labelled sections: "Order Sizing", "Risk Management", "Farm Mode Exit Rules", "Trade Mode Exit Rules", and "Cooldown".
4. THE Dashboard SHALL provide an "Apply" button that submits all modified fields to `POST /api/config` and displays a success or error toast notification.
5. THE Dashboard SHALL provide a "Reset to Defaults" button that calls `DELETE /api/config` and refreshes all input fields with the returned base values.
6. WHEN a `POST /api/config` response returns HTTP 400, THE Dashboard SHALL display the error message returned by the API inline near the relevant field or in a toast notification.
7. THE Dashboard SHALL render the Config Overrides panel correctly on viewports as narrow as 320px (mobile) and as wide as 1920px (desktop).
8. WHILE a config apply or reset request is in flight, THE Dashboard SHALL disable the "Apply" and "Reset to Defaults" buttons to prevent duplicate submissions.

---

### Requirement 6: Config Override Persistence Across Bot Restarts

**User Story:** As an Operator, I want config overrides to survive a bot restart, so that I do not have to re-enter my settings after a container redeploy.

#### Acceptance Criteria

1. THE Config_Store SHALL persist active overrides to a local JSON file (`config-overrides.json`) in the working directory whenever an override is applied or cleared.
2. WHEN the bot process starts, THE Config_Store SHALL load `config-overrides.json` if it exists and apply the stored overrides before the first bot tick.
3. IF `config-overrides.json` is missing or contains invalid JSON, THEN THE Config_Store SHALL log a warning and start with no overrides applied.
4. IF `config-overrides.json` contains a stored value that fails current validation rules, THEN THE Config_Store SHALL discard that individual value, log a warning, and continue loading the remaining valid overrides.
