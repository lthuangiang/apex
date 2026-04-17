/**
 * Type system exports for modular architecture
 * 
 * This file provides a centralized export point for all type definitions
 * used throughout the modular trading system.
 */

// Core interfaces and types
export * from './core.js';

// Configuration types
export * from './config.js';

// Error types and validation
export * from './errors.js';

// Utility types and interfaces
export * from './utils.js';

// Re-export commonly used types for convenience
export type {
  // Core interfaces
  IStrategy,
  IExecutionEngine,
  IExchangeAdapter,
  IStateMachine,
  
  // Signal and execution types
  TradingSignal,
  MarketContext,
  ExecutionContext,
  ExecutionResult,
  OrderRequest,
  OrderResult,
  
  // Position and order types
  Position,
  Order,
  Orderbook,
  RawTrade,
  
  // State and event types
  BotState,
  StateEvent,
  StateTransition,
  EventData,
  EventHandler,
  
  // Risk management
  RiskLimits,
  RiskValidationResult,
  
  // Enums
  OrderStatus,
  OrderType,
  TimeInForce,
  TradingRegime
} from './core.js';

export type {
  // Configuration types
  SystemConfig,
  AdapterConfig,
  StrategyConfig,
  RunnerConfig,
  ExecutionParams,
  // Configuration models
  AdapterCredentials,
  AdapterEndpoints,
  RateLimits,
  ConnectionConfig,
  RetryConfig,
  PositionSizingParams,
  TakeProfitParams,
  StopLossParams,
  ExecutionTimingParams,
  ApiConfig,
  MonitoringConfig,
  LoggingConfig,
  MetricsConfig,
  AlertingConfig,
  FeatureFlags,
  
  // Validation
  ConfigValidationResult,
  ConfigValidationError,
  ConfigValidationWarning
} from './config.js';

export {
  // Error classes
  SystemError,
  ConfigurationError,
  InvalidConfigurationError,
  MissingConfigurationError,
  ConfigurationValidationError,
  AdapterError,
  AdapterConnectionError,
  AdapterAuthenticationError,
  AdapterRateLimitError,
  AdapterApiError,
  AdapterNotFoundError,
  AdapterNotSupportedError,
  StrategyError,
  StrategyNotFoundError,
  InvalidSignalError,
  StrategyTimeoutError,
  ExecutionError,
  OrderPlacementError,
  OrderCancellationError,
  RiskLimitViolationError,
  InsufficientBalanceError,
  StateMachineError,
  InvalidStateTransitionError,
  StateMachineTimeoutError,
  RunnerError,
  RunnerNotFoundError,
  RunnerAlreadyExistsError,
  RunnerStartupError,
  RunnerShutdownError,
  EventBusError,
  EventDeliveryError,
  EventTimeoutError,
  ValidationError,
  SchemaValidationError,
  
  // Validation utilities
  ValidationRules,
  isRecoverableError,
  getErrorCode,
  createErrorContext,
  formatErrorForLogging
} from './errors.js';

export type {
  // Error types
  ErrorJSON,
  ValidationRule,
  ValidationResult,
  Schema,
  FieldSchema
} from './errors.js';