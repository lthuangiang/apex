/**
 * Integration tests for EventBus core requirements
 * 
 * **Validates: Requirements 7.1, 7.2, 7.4, 7.5**
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus } from '../EventBus.js';
import { EventData } from '../../types/core.js';

describe('EventBus Integration Tests', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  afterEach(async () => {
    await eventBus.shutdown();
  });

  describe('Property 7: Event-Driven Communication', () => {
    it('should deliver events in chronological order', async () => {
      const receivedEvents: Array<{ type: string; payload: any; timestamp: Date }> = [];
      const handler = vi.fn((data: EventData) => {
        receivedEvents.push({
          type: data.type,
          payload: data.payload,
          timestamp: data.timestamp
        });
      });

      eventBus.subscribe('order-test', handler);
      eventBus.subscribe('price-update', handler);

      // Emit events with small delays to ensure different timestamps
      await eventBus.emit('order-test', { id: 1 }, 'test-source');
      await new Promise(resolve => setTimeout(resolve, 2));
      
      await eventBus.emit('price-update', { id: 2 }, 'test-source');
      await new Promise(resolve => setTimeout(resolve, 2));
      
      await eventBus.emit('order-test', { id: 3 }, 'test-source');

      // Wait for all events to be processed
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify chronological ordering
      expect(receivedEvents).toHaveLength(3);
      
      for (let i = 1; i < receivedEvents.length; i++) {
        const prevEvent = receivedEvents[i - 1];
        const currentEvent = receivedEvents[i];
        
        expect(prevEvent.timestamp.getTime()).toBeLessThanOrEqual(
          currentEvent.timestamp.getTime()
        );
      }

      // Verify correct event order
      expect(receivedEvents[0].payload.id).toBe(1);
      expect(receivedEvents[1].payload.id).toBe(2);
      expect(receivedEvents[2].payload.id).toBe(3);
    });

    it('should support multiple subscribers per event type', async () => {
      const handler1Calls: any[] = [];
      const handler2Calls: any[] = [];
      const handler3Calls: any[] = [];

      const handler1 = vi.fn((data: EventData) => handler1Calls.push(data.payload));
      const handler2 = vi.fn((data: EventData) => handler2Calls.push(data.payload));
      const handler3 = vi.fn((data: EventData) => handler3Calls.push(data.payload));

      eventBus.subscribe('test-event', handler1);
      eventBus.subscribe('test-event', handler2);
      eventBus.subscribe('test-event', handler3);

      await eventBus.emit('test-event', { message: 'hello' });
      await eventBus.emit('test-event', { message: 'world' });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 50));

      // All handlers should receive all events
      expect(handler1Calls).toHaveLength(2);
      expect(handler2Calls).toHaveLength(2);
      expect(handler3Calls).toHaveLength(2);

      // Verify event content
      expect(handler1Calls[0].message).toBe('hello');
      expect(handler1Calls[1].message).toBe('world');
      expect(handler2Calls[0].message).toBe('hello');
      expect(handler2Calls[1].message).toBe('world');
      expect(handler3Calls[0].message).toBe('hello');
      expect(handler3Calls[1].message).toBe('world');
    });

    it('should handle subscriber priority ordering', async () => {
      const callOrder: string[] = [];

      const lowPriorityHandler = vi.fn(() => callOrder.push('low'));
      const highPriorityHandler = vi.fn(() => callOrder.push('high'));
      const mediumPriorityHandler = vi.fn(() => callOrder.push('medium'));

      eventBus.subscribe('priority-event', lowPriorityHandler, { priority: 1 });
      eventBus.subscribe('priority-event', highPriorityHandler, { priority: 10 });
      eventBus.subscribe('priority-event', mediumPriorityHandler, { priority: 5 });

      await eventBus.emit('priority-event', { data: 'test' });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify priority order (highest first)
      expect(callOrder).toEqual(['high', 'medium', 'low']);
    });

    it('should provide event ordering and delivery guarantees', async () => {
      const eventBusWithOrdering = new EventBus({
        ordering: { enabled: true, strategy: 'timestamp' }
      });

      try {
        const receivedEvents: Array<{ id: number; timestamp: Date }> = [];
        const handler = vi.fn((data: EventData) => {
          receivedEvents.push({
            id: data.payload.id,
            timestamp: data.timestamp
          });
        });

        eventBusWithOrdering.subscribe('ordered-event', handler);

        // Emit events rapidly
        for (let i = 1; i <= 5; i++) {
          await eventBusWithOrdering.emit('ordered-event', { id: i });
          // Small delay to ensure different timestamps
          await new Promise(resolve => setTimeout(resolve, 1));
        }

        // Wait for processing
        await new Promise(resolve => setTimeout(resolve, 100));

        // Verify all events delivered
        expect(receivedEvents).toHaveLength(5);

        // Verify chronological order
        for (let i = 1; i < receivedEvents.length; i++) {
          expect(receivedEvents[i - 1].timestamp.getTime()).toBeLessThanOrEqual(
            receivedEvents[i].timestamp.getTime()
          );
        }

        // Verify correct sequence
        for (let i = 0; i < receivedEvents.length; i++) {
          expect(receivedEvents[i].id).toBe(i + 1);
        }

      } finally {
        await eventBusWithOrdering.shutdown();
      }
    });

    it('should handle event-driven communication without direct method calls', async () => {
      // This test verifies that components can communicate through events
      // without direct coupling
      
      class ComponentA {
        constructor(private eventBus: EventBus) {}
        
        async performAction(data: any) {
          // Component A emits an event instead of calling Component B directly
          await this.eventBus.emit('action-performed', data, 'ComponentA');
        }
      }
      
      class ComponentB {
        public receivedData: any[] = [];
        
        constructor(private eventBus: EventBus) {
          // Component B subscribes to events instead of being called directly
          this.eventBus.subscribe('action-performed', (data: EventData) => {
            this.receivedData.push(data.payload);
          });
        }
      }

      const componentA = new ComponentA(eventBus);
      const componentB = new ComponentB(eventBus);

      // Component A performs actions
      await componentA.performAction({ action: 'create', id: 1 });
      await componentA.performAction({ action: 'update', id: 2 });

      // Wait for event processing
      await new Promise(resolve => setTimeout(resolve, 50));

      // Component B should have received the events
      expect(componentB.receivedData).toHaveLength(2);
      expect(componentB.receivedData[0]).toEqual({ action: 'create', id: 1 });
      expect(componentB.receivedData[1]).toEqual({ action: 'update', id: 2 });
    });

    it('should maintain delivery guarantees under concurrent operations', async () => {
      const receivedEvents: Array<{ id: number; source: string }> = [];
      const handler = vi.fn((data: EventData) => {
        receivedEvents.push({
          id: data.payload.id,
          source: data.source
        });
      });

      eventBus.subscribe('concurrent-event', handler);

      // Emit events concurrently from different sources
      const emissionPromises = [];
      
      for (let i = 1; i <= 10; i++) {
        emissionPromises.push(
          eventBus.emit('concurrent-event', { id: i }, `source-${i % 3}`)
        );
      }

      await Promise.all(emissionPromises);

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 100));

      // All events should be delivered
      expect(receivedEvents).toHaveLength(10);

      // Verify all IDs are present (order may vary due to concurrency)
      const receivedIds = receivedEvents.map(e => e.id).sort((a, b) => a - b);
      const expectedIds = Array.from({ length: 10 }, (_, i) => i + 1);
      expect(receivedIds).toEqual(expectedIds);
    });
  });
});