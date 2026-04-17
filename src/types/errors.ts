/**
 * Error types and validation schemas for the modular architecture
 * 
 * This file defines all error classes, validation schemas, and error handling
 * utilities used throughout the system.
 */

import { BotState, TradingSignal, ExecutionContext } from './core.js';
import { AdapterConfig, StrategyConfig, RunnerConfig } from './config.js';

// ============================================================================
// BASE ERROR CLASSES
// ============================================================================

/**
 * Base error class for all system errors
 */
export abstract class SystemError extends Error {
  /** Error code for programmatic handling */
  public code: string;
  
  /** Error context for debugging */
  public readonly context: Record<string, any>;
  
  /** Error timestamp */
  public readonly timestamp: Date;
  
  /** Whether error is recoverable */
  public readonly recoverable: boolean;
  
  constructor(
    message: string,
    code: string,
    context: Record<string, any> = {},
    recoverable: boolean = false
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.context = context;
    this.timestamp = new Date();
    this.recoverable = recoverable;
    
    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
  
  /**
   * Convert error to JSON for logging/serialization
   */
  toJSON(): ErrorJSON {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      timestamp: this.timestamp.toISOString(),
      recoverable: this.recoverable,
      stack: this.stack
    };
  }
}

/**
 * JSON representation of an error
 */
export interface ErrorJSON {
  name: string;
  message: string;
  code: string;
  context: Record<string, any>;
  timestamp: string;
  recoverable: boolean;
  stack?: string;
}

// ============================================================================
// CONFIGURATION ERRORS
// ============================================================================

/**
 * Configuration-related errors
 */
export class ConfigurationError extends SystemError {
  constructor(message: string, context: Record<string, any> = {}) {
    super(message, 'CONFIG_ERROR', context, false);
  }
}

/**
 * Invalid configuration error
 */
export class InvalidConfigurationError extends ConfigurationError {
  constructor(path: string, reason: string, context: Record<string, any> = {}) {
    super(`Invalid configuration at '${path}': ${reason}`, {
      ...context,
      path,
      reason
    });
    this.code = 'INVALID_CONFIG';
  }
}

/**
 * Missing configuration error
 */
export class MissingConfigurationError extends ConfigurationError {
  constructor(path: string, context: Record<string, any> = {}) {
    super(`Missing required configuration: '${path}'`, {
      ...context,
      path
    });
    this.code = 'MISSING_CONFIG';
  }
}

/**
 * Configuration validation error
 */
export class ConfigurationValidationError extends ConfigurationError {
  public readonly validationErrors: ValidationError[];
  
  constructor(errors: ValidationError[], context: Record<string, any> = {}) {
    const message = `Configuration validation failed: ${errors.length} error(s)`;
    super(message, {
      ...context,
      errors: errors.map(e => e.toJSON())
    });
    this.code = 'CONFIG_VALIDATION_ERROR';
    this.validationErrors = errors;
  }
}

// ============================================================================
// ADAPTER ERRORS
// ============================================================================

/**
 * Exchange adapter errors
 */
export class AdapterError extends SystemError {
  public readonly exchangeName: string;
  
  constructor(
    exchangeName: string,
    message: string,
    context: Record<string, any> = {},
    recoverable: boolean = true
  ) {
    super(message, 'ADAPTER_ERROR', { ...context, exchangeName }, recoverable);
    this.exchangeName = exchangeName;
  }
}

/**
 * Adapter connection error
 */
export class AdapterConnectionError extends AdapterError {
  constructor(exchangeName: string, reason: string, context: Record<string, any> = {}) {
    super(exchangeName, `Connection failed: ${reason}`, context, true);
    this.code = 'ADAPTER_CONNECTION_ERROR';
  }
}

/**
 * Adapter authentication error
 */
export class AdapterAuthenticationError extends AdapterError {
  constructor(exchangeName: string, context: Record<string, any> = {}) {
    super(exchangeName, 'Authentication failed', context, false);
    this.code = 'ADAPTER_AUTH_ERROR';
  }
}

/**
 * Adapter rate limit error
 */
export class AdapterRateLimitError extends AdapterError {
  public readonly retryAfter?: number;
  
  constructor(
    exchangeName: string,
    retryAfter?: number,
    context: Record<string, any> = {}
  ) {
    super(exchangeName, 'Rate limit exceeded', { ...context, retryAfter }, true);
    this.code = 'ADAPTER_RATE_LIMIT';
    this.retryAfter = retryAfter;
  }
}

/**
 * Adapter API error
 */
export class AdapterApiError extends AdapterError {
  public readonly statusCode?: number;
  public readonly apiCode?: string;
  
  constructor(
    exchangeName: string,
    message: string,
    statusCode?: number,
    apiCode?: string,
    context: Record<string, any> = {}
  ) {
    super(exchangeName, message, { ...context, statusCode, apiCode }, true);
    this.code = 'ADAPTER_API_ERROR';
    this.statusCode = statusCode;
    this.apiCode = apiCode;
  }
}

/**
 * Adapter not found error
 */
export class AdapterNotFoundError extends AdapterError {
  constructor(exchangeName: string, context: Record<string, any> = {}) {
    super(exchangeName, `Adapter not found: ${exchangeName}`, context, false);
    this.code = 'ADAPTER_NOT_FOUND';
  }
}

/**
 * Adapter not supported error
 */
export class AdapterNotSupportedError extends AdapterError {
  public readonly feature: string;
  
  constructor(
    exchangeName: string,
    feature: string,
    context: Record<string, any> = {}
  ) {
    super(exchangeName, `Feature not supported: ${feature}`, { ...context, feature }, false);
    this.code = 'ADAPTER_NOT_SUPPORTED';
    this.feature = feature;
  }
}

// ============================================================================
// STRATEGY ERRORS
// ============================================================================

/**
 * Strategy-related errors
 */
export class StrategyError extends SystemError {
  public readonly strategyName: string;
  
  constructor(
    strategyName: string,
    message: string,
    context: Record<string, any> = {},
    recoverable: boolean = true
  ) {
    super(message, 'STRATEGY_ERROR', { ...context, strategyName }, recoverable);
    this.strategyName = strategyName;
  }
}

/**
 * Strategy not found error
 */
export class StrategyNotFoundError extends StrategyError {
  constructor(strategyName: string, context: Record<string, any> = {}) {
    super(strategyName, `Strategy not found: ${strategyName}`, context, false);
    this.code = 'STRATEGY_NOT_FOUND';
  }
}

/**
 * Invalid strategy signal error
 */
export class InvalidSignalError extends StrategyError {
  public readonly signal: TradingSignal;
  
  constructor(
    strategyName: string,
    signal: TradingSignal,
    reason: string,
    context: Record<string, any> = {}
  ) {
    super(strategyName, `Invalid signal: ${reason}`, { ...context, signal }, true);
    this.code = 'INVALID_SIGNAL';
    this.signal = signal;
  }
}

/**
 * Strategy timeout error
 */
export class StrategyTimeoutError extends StrategyError {
  public readonly timeoutMs: number;
  
  constructor(
    strategyName: string,
    timeoutMs: number,
    context: Record<string, any> = {}
  ) {
    super(strategyName, `Strategy timeout after ${timeoutMs}ms`, { ...context, timeoutMs }, true);
    this.code = 'STRATEGY_TIMEOUT';
    this.timeoutMs = timeoutMs;
  }
}

// ============================================================================
// EXECUTION ERRORS
// ============================================================================

/**
 * Execution engine errors
 */
export class ExecutionError extends SystemError {
  constructor(
    message: string,
    context: Record<string, any> = {},
    recoverable: boolean = true
  ) {
    super(message, 'EXECUTION_ERROR', context, recoverable);
  }
}

/**
 * Order placement error
 */
export class OrderPlacementError extends ExecutionError {
  public readonly symbol: string;
  public readonly orderRequest: any;
  
  constructor(
    symbol: string,
    orderRequest: any,
    reason: string,
    context: Record<string, any> = {}
  ) {
    super(`Order placement failed for ${symbol}: ${reason}`, {
      ...context,
      symbol,
      orderRequest
    }, true);
    this.code = 'ORDER_PLACEMENT_ERROR';
    this.symbol = symbol;
    this.orderRequest = orderRequest;
  }
}

/**
 * Order cancellation error
 */
export class OrderCancellationError extends ExecutionError {
  public readonly orderId: string;
  public readonly symbol: string;
  
  constructor(
    orderId: string,
    symbol: string,
    reason: string,
    context: Record<string, any> = {}
  ) {
    super(`Order cancellation failed for ${orderId}: ${reason}`, {
      ...context,
      orderId,
      symbol
    }, true);
    this.code = 'ORDER_CANCELLATION_ERROR';
    this.orderId = orderId;
    this.symbol = symbol;
  }
}

/**
 * Risk limit violation error
 */
export class RiskLimitViolationError extends ExecutionError {
  public readonly limitType: string;
  public readonly currentValue: number;
  public readonly limitValue: number;
  
  constructor(
    limitType: string,
    currentValue: number,
    limitValue: number,
    context: Record<string, any> = {}
  ) {
    super(
      `Risk limit violation: ${limitType} (${currentValue} > ${limitValue})`,
      { ...context, limitType, currentValue, limitValue },
      false
    );
    this.code = 'RISK_LIMIT_VIOLATION';
    this.limitType = limitType;
    this.currentValue = currentValue;
    this.limitValue = limitValue;
  }
}

/**
 * Insufficient balance error
 */
export class InsufficientBalanceError extends ExecutionError {
  public readonly required: number;
  public readonly available: number;
  
  constructor(
    required: number,
    available: number,
    context: Record<string, any> = {}
  ) {
    super(
      `Insufficient balance: required ${required}, available ${available}`,
      { ...context, required, available },
      true
    );
    this.code = 'INSUFFICIENT_BALANCE';
    this.required = required;
    this.available = available;
  }
}

// ============================================================================
// STATE MACHINE ERRORS
// ============================================================================

/**
 * State machine errors
 */
export class StateMachineError extends SystemError {
  constructor(
    message: string,
    context: Record<string, any> = {},
    recoverable: boolean = false
  ) {
    super(message, 'STATE_MACHINE_ERROR', context, recoverable);
  }
}

/**
 * Invalid state transition error
 */
export class InvalidStateTransitionError extends StateMachineError {
  public readonly fromState: BotState;
  public readonly toState: BotState;
  public readonly event: string;
  
  constructor(
    fromState: BotState,
    toState: BotState,
    event: string,
    context: Record<string, any> = {}
  ) {
    super(
      `Invalid state transition: ${fromState} -> ${toState} (event: ${event})`,
      { ...context, fromState, toState, event },
      false
    );
    this.code = 'INVALID_STATE_TRANSITION';
    this.fromState = fromState;
    this.toState = toState;
    this.event = event;
  }
}

/**
 * State machine timeout error
 */
export class StateMachineTimeoutError extends StateMachineError {
  public readonly state: BotState;
  public readonly timeoutMs: number;
  
  constructor(
    state: BotState,
    timeoutMs: number,
    context: Record<string, any> = {}
  ) {
    super(
      `State machine timeout in state ${state} after ${timeoutMs}ms`,
      { ...context, state, timeoutMs },
      true
    );
    this.code = 'STATE_MACHINE_TIMEOUT';
    this.state = state;
    this.timeoutMs = timeoutMs;
  }
}

// ============================================================================
// RUNNER ERRORS
// ============================================================================

/**
 * Bot runner errors
 */
export class RunnerError extends SystemError {
  public readonly runnerId: string;
  
  constructor(
    runnerId: string,
    message: string,
    context: Record<string, any> = {},
    recoverable: boolean = true
  ) {
    super(message, 'RUNNER_ERROR', { ...context, runnerId }, recoverable);
    this.runnerId = runnerId;
  }
}

/**
 * Runner not found error
 */
export class RunnerNotFoundError extends RunnerError {
  constructor(runnerId: string, context: Record<string, any> = {}) {
    super(runnerId, `Runner not found: ${runnerId}`, context, false);
    this.code = 'RUNNER_NOT_FOUND';
  }
}

/**
 * Runner already exists error
 */
export class RunnerAlreadyExistsError extends RunnerError {
  constructor(runnerId: string, context: Record<string, any> = {}) {
    super(runnerId, `Runner already exists: ${runnerId}`, context, false);
    this.code = 'RUNNER_ALREADY_EXISTS';
  }
}

/**
 * Runner startup error
 */
export class RunnerStartupError extends RunnerError {
  constructor(runnerId: string, reason: string, context: Record<string, any> = {}) {
    super(runnerId, `Runner startup failed: ${reason}`, context, true);
    this.code = 'RUNNER_STARTUP_ERROR';
  }
}

/**
 * Runner shutdown error
 */
export class RunnerShutdownError extends RunnerError {
  constructor(runnerId: string, reason: string, context: Record<string, any> = {}) {
    super(runnerId, `Runner shutdown failed: ${reason}`, context, true);
    this.code = 'RUNNER_SHUTDOWN_ERROR';
  }
}

// ============================================================================
// EVENT BUS ERRORS
// ============================================================================

/**
 * Event bus errors
 */
export class EventBusError extends SystemError {
  constructor(
    message: string,
    context: Record<string, any> = {},
    recoverable: boolean = true
  ) {
    super(message, 'EVENT_BUS_ERROR', context, recoverable);
  }
}

/**
 * Event delivery error
 */
export class EventDeliveryError extends EventBusError {
  public readonly eventType: string;
  public readonly handlerName: string;
  
  constructor(
    eventType: string,
    handlerName: string,
    reason: string,
    context: Record<string, any> = {}
  ) {
    super(
      `Event delivery failed: ${eventType} to ${handlerName} (${reason})`,
      { ...context, eventType, handlerName },
      true
    );
    this.code = 'EVENT_DELIVERY_ERROR';
    this.eventType = eventType;
    this.handlerName = handlerName;
  }
}

/**
 * Event timeout error
 */
export class EventTimeoutError extends EventBusError {
  public readonly eventType: string;
  public readonly timeoutMs: number;
  
  constructor(
    eventType: string,
    timeoutMs: number,
    context: Record<string, any> = {}
  ) {
    super(
      `Event processing timeout: ${eventType} after ${timeoutMs}ms`,
      { ...context, eventType, timeoutMs },
      true
    );
    this.code = 'EVENT_TIMEOUT';
    this.eventType = eventType;
    this.timeoutMs = timeoutMs;
  }
}

// ============================================================================
// VALIDATION ERRORS
// ============================================================================

/**
 * Generic validation error
 */
export class ValidationError extends SystemError {
  public readonly field: string;
  public readonly value: any;
  public readonly constraint: string;
  
  constructor(
    field: string,
    value: any,
    constraint: string,
    context: Record<string, any> = {}
  ) {
    super(
      `Validation failed for field '${field}': ${constraint}`,
      'VALIDATION_ERROR',
      { ...context, field, value, constraint },
      false
    );
    this.field = field;
    this.value = value;
    this.constraint = constraint;
  }
}

/**
 * Schema validation error
 */
export class SchemaValidationError extends ValidationError {
  public readonly schema: string;
  
  constructor(
    schema: string,
    field: string,
    value: any,
    constraint: string,
    context: Record<string, any> = {}
  ) {
    super(field, value, constraint, { ...context, schema });
    this.code = 'SCHEMA_VALIDATION_ERROR';
    this.schema = schema;
  }
}

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

/**
 * Validation rule interface
 */
export interface ValidationRule {
  /** Rule name */
  name: string;
  
  /** Validation function */
  validate: (value: any, context?: any) => ValidationResult;
  
  /** Error message template */
  message: string;
  
  /** Whether rule is required */
  required?: boolean;
}

/**
 * Validation result
 */
export interface ValidationResult {
  /** Whether validation passed */
  isValid: boolean;
  
  /** Error message if validation failed */
  error?: string;
  
  /** Validation warnings */
  warnings?: string[];
  
  /** Suggested fixes */
  suggestions?: string[];
}

/**
 * Schema definition
 */
export interface Schema {
  /** Schema name */
  name: string;
  
  /** Field definitions */
  fields: Record<string, FieldSchema>;
  
  /** Schema-level validation rules */
  rules?: ValidationRule[];
  
  /** Whether unknown fields are allowed */
  allowUnknownFields?: boolean;
}

/**
 * Field schema definition
 */
export interface FieldSchema {
  /** Field type */
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any';
  
  /** Whether field is required */
  required?: boolean;
  
  /** Default value */
  default?: any;
  
  /** Field validation rules */
  rules?: ValidationRule[];
  
  /** Nested schema for objects */
  schema?: Schema;
  
  /** Array item schema */
  items?: FieldSchema;
  
  /** Field description */
  description?: string;
}

// ============================================================================
// BUILT-IN VALIDATION RULES
// ============================================================================

/**
 * Common validation rules
 */
export const ValidationRules = {
  required: (): ValidationRule => ({
    name: 'required',
    validate: (value) => ({
      isValid: value !== null && value !== undefined && value !== '',
      error: value === null || value === undefined ? 'Field is required' : undefined
    }),
    message: 'Field is required'
  }),
  
  minLength: (min: number): ValidationRule => ({
    name: 'minLength',
    validate: (value) => ({
      isValid: typeof value === 'string' && value.length >= min,
      error: typeof value !== 'string' || value.length < min 
        ? `Minimum length is ${min}` : undefined
    }),
    message: `Minimum length is ${min}`
  }),
  
  maxLength: (max: number): ValidationRule => ({
    name: 'maxLength',
    validate: (value) => ({
      isValid: typeof value === 'string' && value.length <= max,
      error: typeof value !== 'string' || value.length > max 
        ? `Maximum length is ${max}` : undefined
    }),
    message: `Maximum length is ${max}`
  }),
  
  min: (min: number): ValidationRule => ({
    name: 'min',
    validate: (value) => ({
      isValid: typeof value === 'number' && value >= min,
      error: typeof value !== 'number' || value < min 
        ? `Minimum value is ${min}` : undefined
    }),
    message: `Minimum value is ${min}`
  }),
  
  max: (max: number): ValidationRule => ({
    name: 'max',
    validate: (value) => ({
      isValid: typeof value === 'number' && value <= max,
      error: typeof value !== 'number' || value > max 
        ? `Maximum value is ${max}` : undefined
    }),
    message: `Maximum value is ${max}`
  }),
  
  pattern: (regex: RegExp): ValidationRule => ({
    name: 'pattern',
    validate: (value) => ({
      isValid: typeof value === 'string' && regex.test(value),
      error: typeof value !== 'string' || !regex.test(value) 
        ? `Value must match pattern ${regex}` : undefined
    }),
    message: `Value must match pattern ${regex}`
  }),
  
  oneOf: (values: any[]): ValidationRule => ({
    name: 'oneOf',
    validate: (value) => ({
      isValid: values.includes(value),
      error: !values.includes(value) 
        ? `Value must be one of: ${values.join(', ')}` : undefined
    }),
    message: `Value must be one of: ${values.join(', ')}`
  }),
  
  positive: (): ValidationRule => ({
    name: 'positive',
    validate: (value) => ({
      isValid: typeof value === 'number' && value > 0,
      error: typeof value !== 'number' || value <= 0 
        ? 'Value must be positive' : undefined
    }),
    message: 'Value must be positive'
  }),
  
  nonNegative: (): ValidationRule => ({
    name: 'nonNegative',
    validate: (value) => ({
      isValid: typeof value === 'number' && value >= 0,
      error: typeof value !== 'number' || value < 0 
        ? 'Value must be non-negative' : undefined
    }),
    message: 'Value must be non-negative'
  })
};

// ============================================================================
// ERROR UTILITIES
// ============================================================================

/**
 * Check if an error is recoverable
 */
export function isRecoverableError(error: Error): boolean {
  return error instanceof SystemError && error.recoverable;
}

/**
 * Extract error code from an error
 */
export function getErrorCode(error: Error): string {
  if (error instanceof SystemError) {
    return error.code;
  }
  return 'UNKNOWN_ERROR';
}

/**
 * Create error context from execution context
 */
export function createErrorContext(
  executionContext?: ExecutionContext,
  additionalContext?: Record<string, any>
): Record<string, any> {
  const context: Record<string, any> = { ...additionalContext };
  
  if (executionContext) {
    context.symbol = executionContext.symbol;
    context.balance = executionContext.balance;
    context.currentPosition = executionContext.currentPosition;
    context.riskLimits = executionContext.riskLimits;
  }
  
  return context;
}

/**
 * Format error for logging
 */
export function formatErrorForLogging(error: Error): Record<string, any> {
  if (error instanceof SystemError) {
    return error.toJSON();
  }
  
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString()
  };
}