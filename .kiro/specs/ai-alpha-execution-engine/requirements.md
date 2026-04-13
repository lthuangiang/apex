# Requirements Document

## Introduction

The AI Alpha Execution Engine replaces the existing rule-based `SignalEngine` in the SoDEX trading bot with an AI-powered decision layer. The system enriches market context by fetching sector data and the fear/greed index from the SoSoValue API, then feeds that data alongside existing technical indicators into an LLM (GPT-4o or Claude) to produce structured trade decisions. Every trade decision is persisted with its AI reasoning, Telegram notifications are enriched with that reasoning, and a minimal real-time web dashboard exposes live PnL and trade history.

## Glossary

- **AI_Signal_Layer**: The new module that replaces `SignalEngine`. Calls SoSoValue and an LLM to produce a `Signal`.
- **SoSoValue_Client**: The HTTP client responsible for fetching sector index and fear/greed data from the SoSoValue API.
- **LLM_Client**: The HTTP client that calls OpenAI or Anthropic to obtain a structured trade decision.
- **TradeLogger**: The module that persists trade records (including AI reasoning) to a JSON file or SQLite database.
- **Dashboard_Server**: The Express.js HTTP server that serves the real-time dashboard web page.
- **Signal**: The structured output `{ base_score, regime, direction, confidence, score }` consumed by `Watcher`.
- **TradeRecord**: A persisted record with fields `{ timestamp, direction, confidence, reasoning, entryPrice, exitPrice, pnl, symbol }`.
- **Fallback_Signal**: The rule-based signal produced by the existing `SignalEngine` logic, used when the AI layer is unavailable.
- **TelegramManager**: The existing module that sends Telegram notifications.
- **Watcher**: The existing state-machine module (`IDLE → PENDING_ENTRY → IN_POSITION → PENDING_EXIT`) that consumes `Signal` and manages trade lifecycle.

---

## Requirements

### Requirement 1: SoSoValue Market Context Fetching

**User Story:** As a trader, I want the bot to fetch sector index and fear/greed data from SoSoValue before each trade decision, so that the AI has broader market context beyond raw price data.

#### Acceptance Criteria

1. WHEN the `AI_Signal_Layer` begins a signal evaluation cycle, THE `SoSoValue_Client` SHALL fetch the current sector index and fear/greed index from the SoSoValue API.
2. WHEN the SoSoValue API responds successfully, THE `SoSoValue_Client` SHALL return a structured object containing `{ sectorIndex, fearGreedIndex, fearGreedLabel }`.
3. IF the SoSoValue API request fails or times out after 5 seconds, THEN THE `SoSoValue_Client` SHALL return `null` and log the error without throwing.
4. THE `SoSoValue_Client` SHALL complete each API request within 5 seconds.

---

### Requirement 2: LLM Trade Decision

**User Story:** As a trader, I want the bot to ask an LLM for a trade direction decision given current market conditions, so that the signal benefits from language-model reasoning over structured market data.

#### Acceptance Criteria

1. WHEN the `AI_Signal_Layer` has collected market data (Binance klines, L/S ratio, orderbook imbalance, trade pressure, and SoSoValue context), THE `LLM_Client` SHALL send a prompt containing all collected data and request a JSON response with the schema `{ direction: "long" | "short" | "skip", confidence: number, reasoning: string }`.
2. WHEN the LLM responds with a valid JSON object matching the schema, THE `AI_Signal_Layer` SHALL map `direction` and `confidence` onto the `Signal` fields consumed by `Watcher`, replacing the rule-based `score`.
3. WHEN the LLM response `confidence` value is outside the range `[0, 1]`, THEN THE `AI_Signal_Layer` SHALL clamp the value to `[0, 1]` before returning the `Signal`.
4. THE `LLM_Client` SHALL complete each inference request within 15 seconds.
5. IF the LLM response cannot be parsed as valid JSON or does not contain the required fields, THEN THE `AI_Signal_Layer` SHALL fall back to the `Fallback_Signal` and log a warning.
6. THE `AI_Signal_Layer` SHALL support configuration of the LLM provider (OpenAI or Anthropic) via an environment variable `LLM_PROVIDER`.

---

### Requirement 3: Fallback to Rule-Based Signal

**User Story:** As a trader, I want the bot to continue operating using the existing rule-based signal when the AI layer is unavailable, so that trading is not interrupted by LLM or API outages.

#### Acceptance Criteria

1. IF the `LLM_Client` request fails, times out, or returns an unparseable response, THEN THE `AI_Signal_Layer` SHALL invoke the existing `SignalEngine` logic and return its output as the `Signal`.
2. IF the `SoSoValue_Client` returns `null`, THEN THE `AI_Signal_Layer` SHALL proceed with LLM inference using only the available Binance-sourced data, without aborting the cycle.
3. WHEN a fallback occurs, THE `AI_Signal_Layer` SHALL include a `fallback: true` flag in the returned `Signal` metadata and log the reason.
4. THE `Watcher` SHALL consume a fallback `Signal` identically to an AI-generated `Signal`, with no change in trade execution behavior.

---

### Requirement 4: Trade Reasoning Persistence

**User Story:** As a trader, I want every completed trade to be saved with its AI reasoning, so that I can review why the bot entered and exited each position.

#### Acceptance Criteria

1. WHEN a trade exit is confirmed (position closed), THE `TradeLogger` SHALL append a `TradeRecord` to the persistent store.
2. THE `TradeRecord` SHALL contain the fields: `timestamp` (ISO 8601), `symbol`, `direction` (`long` | `short`), `confidence` (number), `reasoning` (string), `entryPrice` (number), `exitPrice` (number), `pnl` (number).
3. WHERE the configured storage backend is `json`, THE `TradeLogger` SHALL write records to a newline-delimited JSON file at the path specified by the `TRADE_LOG_PATH` environment variable.
4. WHERE the configured storage backend is `sqlite`, THE `TradeLogger` SHALL insert records into a SQLite database at the path specified by `TRADE_LOG_PATH`.
5. IF a write operation fails, THEN THE `TradeLogger` SHALL log the error and continue bot operation without throwing.
6. THE `TradeLogger` SHALL be configurable via the `TRADE_LOG_BACKEND` environment variable accepting values `json` or `sqlite`.

---

### Requirement 5: Enriched Telegram Notifications

**User Story:** As a trader, I want Telegram entry and exit messages to include the AI reasoning snippet, so that I can understand the bot's decision at a glance without opening the dashboard.

#### Acceptance Criteria

1. WHEN a trade entry is confirmed, THE `TelegramManager` SHALL include the `reasoning` field from the `Signal` in the entry notification message, truncated to 200 characters.
2. WHEN a trade exit is confirmed, THE `TelegramManager` SHALL include the `reasoning` field from the `TradeRecord` in the exit notification message, truncated to 200 characters.
3. WHEN the `Signal` was produced by the `Fallback_Signal` path, THE `TelegramManager` SHALL label the notification with `[Fallback Mode]` instead of displaying AI reasoning.
4. THE `TelegramManager` SHALL preserve all existing notification fields (symbol, direction, size, entry price, PnL, session PnL) alongside the new reasoning field.

---

### Requirement 6: Dashboard Web Server

**User Story:** As a trader, I want a minimal web page showing real-time PnL and trade history with AI reasoning, so that I can monitor the bot's performance without reading raw log files.

#### Acceptance Criteria

1. THE `Dashboard_Server` SHALL serve an HTTP endpoint at `GET /` that returns an HTML page displaying trade history and current session PnL.
2. THE `Dashboard_Server` SHALL serve an HTTP endpoint at `GET /api/trades` that returns all `TradeRecord` entries as a JSON array, ordered by `timestamp` descending.
3. THE `Dashboard_Server` SHALL serve an HTTP endpoint at `GET /api/pnl` that returns the current session PnL as `{ sessionPnl: number, updatedAt: string }`.
4. THE `Dashboard_Server` SHALL listen on the port specified by the `DASHBOARD_PORT` environment variable, defaulting to `3000`.
5. THE `Dashboard_Server` SHALL start automatically when the bot process starts.

---

### Requirement 7: Real-Time PnL Updates on Dashboard

**User Story:** As a trader, I want the dashboard PnL to update in real time without manually refreshing the page, so that I can monitor live performance.

#### Acceptance Criteria

1. THE dashboard HTML page SHALL poll `GET /api/pnl` at an interval of 5 seconds and update the displayed PnL value without a full page reload.
2. WHEN the `Watcher` updates `sessionCurrentPnl`, THE `Dashboard_Server` SHALL reflect the updated value on the next poll response from `GET /api/pnl`.
3. THE dashboard HTML page SHALL display each `TradeRecord` in a table with columns: `timestamp`, `symbol`, `direction`, `confidence`, `entryPrice`, `exitPrice`, `pnl`, and `reasoning`.

---

### Requirement 8: AI Reasoning Visible Per Trade in Dashboard

**User Story:** As a trader, I want to see the AI reasoning for each trade in the dashboard, so that I can audit the bot's decision-making over time.

#### Acceptance Criteria

1. THE dashboard trade history table SHALL display the full `reasoning` text for each `TradeRecord`.
2. WHEN a `TradeRecord` was produced by the `Fallback_Signal` path, THE dashboard SHALL display `"Fallback — rule-based signal"` in the reasoning column for that record.
3. THE `Dashboard_Server` SHALL read `TradeRecord` entries directly from the `TradeLogger` persistent store on each `GET /api/trades` request.
