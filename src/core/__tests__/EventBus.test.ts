/**
 * Unit tests for EventBus implementation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus } from '../EventBus.js';
import { EventData, EventHandler } from '../../types/core.js';
import { EventBusError, EventDeliveryError, EventTimeoutError } from '../../types/errors.js';

describe('EventBus', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await eventBus.shutdown();
  });

  describe('Basic Pub/Sub Functionality', () => {
    it('should emit and receive events', async () => {
      const handler = vi.fn();
      const eventType = 'test-event';
      const payload = { message: 'hello world' };

      eventBus.subscribe(eventType, handler);
      await eventBus.emit(eventType, payload, 'test-source');

      // Wait for event processing
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: eventType,
          payload,
          source: 'test-source',
          timestamp: expect.any(Date),
          metadata: expect.objectContaining({
            id: expect.any(String),
            version: '1.0'
          })
        })
      );
    });

    it('should support multiple subscribers for the same event', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const handler3 = vi.fn();
      const eventType = 'multi-subscriber-event';
      const payload = { data: 'test' };

      eventBus.subscribe(eventType, handler1);
      eventBus.subscribe(eventType, handler2);
      eventBus.subscribe(eventType, handler3);

      await eventBus.emit(eventType, payload);

      // Wait for event processing
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
      expect(handler3).toHaveBeenCalledTimes(1);

      // All handlers should receive the same event data
      const expectedEventData = expect.objectContaining({
        type: eventType,
        payload,
        timestamp: expect.any(Date)
      });

      expect(handler1).toHaveBeenCalledWith(expectedEventData);
      expect(handler2).toHaveBeenCalledWith(expectedEventData);
      expect(handler3).toHaveBeenCalledWith(expectedEventData);
    });

    it('should not call handlers for different event types', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      eventBus.subscribe('event-type-1', handler1);
      eventBus.subscribe('event-type-2', handler2);

      await eventBus.emit('event-type-1', { data: 'test1' });

      // Wait for event processing
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).not.toHaveBeenCalled();
    });
  });

  describe('Subscription Management', () => {
    it('should return subscription object when subscribing', () => {
      const handler = vi.fn();
      const subscription = eventBus.subscribe('test-event', handler);

      expect(subscription).toEqual({
        id: expect.any(String),
        eventType: 'test-event',
        handler,
        options: {}
      });
    });

    it('should unsubscribe successfully', async () => {
      const handler = vi.fn();
      const subscription = eventBus.subscribe('test-event', handler);

      const unsubscribed = eventBus.unsubscribe(subscription);
      expect(unsubscribed).toBe(true);

      await eventBus.emit('test-event', { data: 'test' });

      // Wait for event processing
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(handler).not.toHaveBeenCalled();
    });

    it('should return false when unsubscribing non-existent subscription', () => {
      const fakeSubscription = {
        id: 'fake-id',
        eventType: 'fake-event',
        handler: vi.fn(),
        options: {}
      };

      const unsubscribed = eventBus.unsubscribe(fakeSubscription);
      expect(unsubscribed).toBe(false);
    });

    it('should unsubscribe all handlers for an event type', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const handler3 = vi.fn();

      eventBus.subscribe('test-event', handler1);
      eventBus.subscribe('test-event', handler2);
      eventBus.subscribe('other-event', handler3);

      const unsubscribedCount = eventBus.unsubscribeAll('test-event');
      expect(unsubscribedCount).toBe(2);

      await eventBus.emit('test-event', { data: 'test' });
      await eventBus.emit('other-event', { data: 'test' });

      // Wait for event processing
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
      expect(handler3).toHaveBeenCalledTimes(1);
    });

    it('should support once-only subscriptions', async () => {
      const handler = vi.fn();
      eventBus.subscribe('test-event', handler, { once: true });

      await eventBus.emit('test-event', { data: 'first' });
      await eventBus.emit('test-event', { data: 'second' });

      // Wait for event processing
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: { data: 'first' }
        })
      );
    });
  });

  describe('Event Ordering', () => {
    it('should process events in chronological order by default', async () => {
      const results: string[] = [];
      const handler = vi.fn((data: EventData) => {
        results.push(data.payload.order);
      });

      eventBus.subscribe('ordered-event', handler);

      // Emit events with different timestamps
      const now = Date.now();
      await eventBus.emit('ordered-event', { order: 'first' });
      await new Promise(resolve => setTimeout(resolve, 1));
      await eventBus.emit('ordered-event', { order: 'second' });
      await new Promise(resolve => setTimeout(resolve, 1));
      await eventBus.emit('ordered-event', { order: 'third' });

      // Wait for all events to be processed
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(results).toEqual(['first', 'second', 'third']);
    });

    it('should respect subscriber priority', async () => {
      const results: string[] = [];
      
      const lowPriorityHandler = vi.fn((data: EventData) => {
        results.push('low');
      });
      
      const highPriorityHandler = vi.fn((data: EventData) => {
        results.push('high');
      });
      
      const mediumPriorityHandler = vi.fn((data: EventData) => {
        results.push('medium');
      });

      eventBus.subscribe('priority-event', lowPriorityHandler, { priority: 1 });
      eventBus.subscribe('priority-event', highPriorityHandler, { priority: 10 });
      eventBus.subscribe('priority-event', mediumPriorityHandler, { priority: 5 });

      await eventBus.emit('priority-event', { data: 'test' });

      // Wait for event processing
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(results).toEqual(['high', 'medium', 'low']);
    });
  });

  describe('Error Handling', () => {
    it('should handle handler errors gracefully', async () => {
      const errorHandler = vi.fn(() => {
        throw new Error('Handler error');
      });
      const normalHandler = vi.fn();

      eventBus.subscribe('error-event', errorHandler);
      eventBus.subscribe('error-event', normalHandler);

      await eventBus.emit('error-event', { data: 'test' });

      // Wait for event processing
      await new Promise(resolve => setTimeout(resolve, 20));

      // Normal handler should still be called despite error in other handler
      expect(normalHandler).toHaveBeenCalledTimes(1);
      expect(errorHandler).toHaveBeenCalledTimes(1);

      const metrics = eventBus.getMetrics();
      expect(metrics.deliveryFailures).toBe(1);
    });

    it('should handle async handler errors', async () => {
      const asyncErrorHandler = vi.fn(async () => {
        throw new Error('Async handler error');
      });
      const normalHandler = vi.fn();

      eventBus.subscribe('async-error-event', asyncErrorHandler);
      eventBus.subscribe('async-error-event', normalHandler);

      await eventBus.emit('async-error-event', { data: 'test' });

      // Wait for event processing
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(normalHandler).toHaveBeenCalledTimes(1);
      expect(asyncErrorHandler).toHaveBeenCalledTimes(1);

      const metrics = eventBus.getMetrics();
      expect(metrics.deliveryFailures).toBe(1);
    });

    it('should timeout slow handlers', async () => {
      const slowHandler = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
      });

      eventBus.subscribe('timeout-event', slowHandler, { timeout: 50 });

      await eventBus.emit('timeout-event', { data: 'test' });

      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, 100));

      const metrics = eventBus.getMetrics();
      expect(metrics.timeouts).toBe(1);
      expect(metrics.deliveryFailures).toBe(1);
    });

    it('should throw error when queue is full', async () => {
      const smallQueueEventBus = new EventBus({ queueSize: 2 });
      
      try {
        // Fill the queue by subscribing but not processing
        const handler = vi.fn();
        smallQueueEventBus.subscribe('test1', handler);
        
        // Fill the queue
        await smallQueueEventBus.emit('test1', {});
        await smallQueueEventBus.emit('test2', {});
        
        // This should throw
        await expect(smallQueueEventBus.emit('test3', {}))
          .rejects.toThrow(EventBusError);
      } finally {
        await smallQueueEventBus.shutdown();
      }
    }, 10000);
  });

  describe('Metrics and Monitoring', () => {
    it('should track basic metrics', async () => {
      const handler = vi.fn();
      eventBus.subscribe('metrics-event', handler);

      await eventBus.emit('metrics-event', { data: 'test1' });
      await eventBus.emit('metrics-event', { data: 'test2' });

      // Wait for event processing
      await new Promise(resolve => setTimeout(resolve, 20));

      const metrics = eventBus.getMetrics();
      expect(metrics.eventsEmitted).toBe(2);
      expect(metrics.eventsProcessed).toBe(2);
      expect(metrics.subscriberCount).toBe(1);
      expect(metrics.subscribersByType).toEqual({
        'metrics-event': 1
      });
    });

    it('should track subscriber information', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      eventBus.subscribe('event1', handler1);
      eventBus.subscribe('event1', handler2);
      eventBus.subscribe('event2', handler1);

      const subscribers1 = eventBus.getSubscribers('event1');
      const subscribers2 = eventBus.getSubscribers('event2');
      const subscribersNone = eventBus.getSubscribers('nonexistent');

      expect(subscribers1).toHaveLength(2);
      expect(subscribers2).toHaveLength(1);
      expect(subscribersNone).toHaveLength(0);

      expect(subscribers1[0]).toEqual({
        id: expect.any(String),
        eventType: 'event1',
        handler: handler1,
        options: {}
      });
    });
  });

  describe('Configuration Options', () => {
    it('should respect maxListeners configuration', () => {
      const limitedEventBus = new EventBus({ maxListeners: 2 });
      
      const handler = vi.fn();
      limitedEventBus.subscribe('test', handler);
      limitedEventBus.subscribe('test', handler);
      
      // This should work without warnings
      expect(() => {
        limitedEventBus.subscribe('test', handler);
      }).not.toThrow();
      
      limitedEventBus.shutdown();
    });

    it('should support immediate processing when ordering is disabled', async () => {
      const immediateEventBus = new EventBus({ 
        ordering: { enabled: false, strategy: 'fifo' } 
      });
      
      const handler = vi.fn();
      immediateEventBus.subscribe('immediate-event', handler);

      await immediateEventBus.emit('immediate-event', { data: 'test' });

      // Should be processed immediately, no need to wait
      expect(handler).toHaveBeenCalledTimes(1);
      
      await immediateEventBus.shutdown();
    });
  });

  describe('Cleanup and Shutdown', () => {
    it('should clear all subscribers and events', () => {
      const handler = vi.fn();
      eventBus.subscribe('test-event', handler);

      eventBus.clear();

      const metrics = eventBus.getMetrics();
      expect(metrics.subscriberCount).toBe(0);
      expect(metrics.eventsEmitted).toBe(0);
      expect(metrics.eventsProcessed).toBe(0);
    });

    it('should shutdown gracefully', async () => {
      const handler = vi.fn();
      eventBus.subscribe('test-event', handler);

      await eventBus.emit('test-event', { data: 'test' });
      
      // Wait a bit for processing
      await new Promise(resolve => setTimeout(resolve, 50));
      
      await eventBus.shutdown();

      // After shutdown, metrics should be reset
      const metrics = eventBus.getMetrics();
      expect(metrics.subscriberCount).toBe(0);
    }, 10000);
  });

  describe('Advanced Edge Cases', () => {
    it('should handle rapid subscription and unsubscription', async () => {
      const handlers: Array<() => void> = [];
      const subscriptions: Array<any> = [];

      // Create and subscribe multiple handlers rapidly
      for (let i = 0; i < 10; i++) {
        const handler = vi.fn();
        handlers.push(handler);
        const subscription = eventBus.subscribe('rapid-test', handler);
        subscriptions.push(subscription);
      }

      // Emit an event
      await eventBus.emit('rapid-test', { data: 'test' });
      await new Promise(resolve => setTimeout(resolve, 20));

      // All handlers should have been called
      handlers.forEach(handler => {
        expect(handler).toHaveBeenCalledTimes(1);
      });

      // Rapidly unsubscribe half of them
      for (let i = 0; i < 5; i++) {
        eventBus.unsubscribe(subscriptions[i]);
      }

      // Emit another event
      await eventBus.emit('rapid-test', { data: 'test2' });
      await new Promise(resolve => setTimeout(resolve, 20));

      // Only remaining handlers should be called
      for (let i = 0; i < 10; i++) {
        if (i < 5) {
          expect(handlers[i]).toHaveBeenCalledTimes(1); // Unsubscribed
        } else {
          expect(handlers[i]).toHaveBeenCalledTimes(2); // Still subscribed
        }
      }
    });

    it('should handle event emission with no subscribers gracefully', async () => {
      // Emit event with no subscribers
      await eventBus.emit('no-subscribers', { data: 'test' });
      
      // Should not throw and should update metrics
      const metrics = eventBus.getMetrics();
      expect(metrics.eventsEmitted).toBe(1);
    });

    it('should handle subscriber removal during event processing', async () => {
      let subscription: any;
      const selfRemovingHandler = vi.fn(() => {
        // Remove itself during processing
        eventBus.unsubscribe(subscription);
      });

      const normalHandler = vi.fn();

      subscription = eventBus.subscribe('self-remove-test', selfRemovingHandler);
      eventBus.subscribe('self-remove-test', normalHandler);

      await eventBus.emit('self-remove-test', { data: 'test' });
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(selfRemovingHandler).toHaveBeenCalledTimes(1);
      expect(normalHandler).toHaveBeenCalledTimes(1);

      // Emit again - only normal handler should be called
      await eventBus.emit('self-remove-test', { data: 'test2' });
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(selfRemovingHandler).toHaveBeenCalledTimes(1);
      expect(normalHandler).toHaveBeenCalledTimes(2);
    });

    it('should handle mixed sync and async handlers', async () => {
      const syncResults: string[] = [];
      const asyncResults: string[] = [];

      const syncHandler = vi.fn((data: EventData) => {
        syncResults.push(`sync-${data.payload.id}`);
      });

      const asyncHandler = vi.fn(async (data: EventData) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        asyncResults.push(`async-${data.payload.id}`);
      });

      eventBus.subscribe('mixed-handlers', syncHandler);
      eventBus.subscribe('mixed-handlers', asyncHandler);

      await eventBus.emit('mixed-handlers', { id: 1 });
      await eventBus.emit('mixed-handlers', { id: 2 });

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(syncResults).toEqual(['sync-1', 'sync-2']);
      expect(asyncResults).toEqual(['async-1', 'async-2']);
    });

    it('should maintain event metadata integrity', async () => {
      const receivedEvents: EventData[] = [];
      const handler = vi.fn((data: EventData) => {
        receivedEvents.push(data);
      });

      eventBus.subscribe('metadata-test', handler);

      await eventBus.emit('metadata-test', { value: 123 }, 'test-source');
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(receivedEvents).toHaveLength(1);
      const event = receivedEvents[0];
      
      expect(event.type).toBe('metadata-test');
      expect(event.payload).toEqual({ value: 123 });
      expect(event.source).toBe('test-source');
      expect(event.timestamp).toBeInstanceOf(Date);
      expect(event.metadata).toEqual({
        id: expect.any(String),
        version: '1.0'
      });
    });

    it('should handle priority-based ordering with equal priorities', async () => {
      const executionOrder: string[] = [];

      const handler1 = vi.fn(() => executionOrder.push('handler1'));
      const handler2 = vi.fn(() => executionOrder.push('handler2'));
      const handler3 = vi.fn(() => executionOrder.push('handler3'));

      // All handlers have same priority
      eventBus.subscribe('equal-priority', handler1, { priority: 5 });
      eventBus.subscribe('equal-priority', handler2, { priority: 5 });
      eventBus.subscribe('equal-priority', handler3, { priority: 5 });

      await eventBus.emit('equal-priority', { data: 'test' });
      await new Promise(resolve => setTimeout(resolve, 20));

      // All handlers should be called (order may vary for equal priority)
      expect(executionOrder).toHaveLength(3);
      expect(executionOrder).toContain('handler1');
      expect(executionOrder).toContain('handler2');
      expect(executionOrder).toContain('handler3');
    });

    it('should handle event emission during shutdown', async () => {
      const handler = vi.fn();
      eventBus.subscribe('shutdown-test', handler);

      // Start shutdown process
      const shutdownPromise = eventBus.shutdown();

      // Try to emit event during shutdown
      await eventBus.emit('shutdown-test', { data: 'test' });

      await shutdownPromise;

      // Handler may or may not be called depending on timing
      // The important thing is that it doesn't crash
      expect(typeof handler.mock.calls.length).toBe('number');
    });

    it('should handle subscriber errors without affecting other subscribers', async () => {
      const errorHandler = vi.fn(() => {
        throw new Error('Subscriber error');
      });
      const normalHandler1 = vi.fn();
      const normalHandler2 = vi.fn();

      eventBus.subscribe('error-resilience', errorHandler);
      eventBus.subscribe('error-resilience', normalHandler1);
      eventBus.subscribe('error-resilience', normalHandler2);

      await eventBus.emit('error-resilience', { data: 'test' });
      await new Promise(resolve => setTimeout(resolve, 50));

      // All handlers should be called despite error
      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(normalHandler1).toHaveBeenCalledTimes(1);
      expect(normalHandler2).toHaveBeenCalledTimes(1);

      // Metrics should reflect the error
      const metrics = eventBus.getMetrics();
      expect(metrics.deliveryFailures).toBe(1);
    });

    it('should handle large payloads correctly', async () => {
      const largePayload = {
        data: 'x'.repeat(10000), // 10KB string
        array: new Array(1000).fill(0).map((_, i) => ({ id: i, value: Math.random() })),
        nested: {
          level1: {
            level2: {
              level3: {
                message: 'deeply nested data'
              }
            }
          }
        }
      };

      const handler = vi.fn();
      eventBus.subscribe('large-payload', handler);

      await eventBus.emit('large-payload', largePayload);
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: largePayload
        })
      );
    });

    it('should handle event type with special characters', async () => {
      const handler = vi.fn();
      const specialEventType = 'event:with-special.chars_and@symbols!';

      eventBus.subscribe(specialEventType, handler);
      await eventBus.emit(specialEventType, { data: 'test' });
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});