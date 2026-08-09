/**
 * @uttily/worker — Tests unitaires du logger finalizer (G5F).
 */

import { describe, it, expect } from 'vitest';
import { CapturingWorkerLogger } from './logger';

describe('CapturingWorkerLogger finalizer events', () => {
  it('capture finalizer_completed avec les compteurs', () => {
    const logger = new CapturingWorkerLogger();
    logger.finalizerCompleted({
      finalizedCount: 5,
      inspectedCount: 7,
      inconsistentCount: 1,
    });

    const event = logger.events.find((e) => e.event === 'finalizer_completed');
    expect(event).toBeDefined();
    expect(event!.timestamp).toBeTypeOf('number');
    expect(event!.finalizedCount).toBe(5);
    expect(event!.inspectedCount).toBe(7);
    expect(event!.inconsistentCount).toBe(1);
  });

  it('capture finalizer_failed avec le failureCode', () => {
    const logger = new CapturingWorkerLogger();
    logger.finalizerFailed({
      failureCode: 'EMAIL_RETRY_WINDOW_EXPIRED',
    });

    const event = logger.events.find((e) => e.event === 'finalizer_failed');
    expect(event).toBeDefined();
    expect(event!.timestamp).toBeTypeOf('number');
    expect(event!.failureCode).toBe('EMAIL_RETRY_WINDOW_EXPIRED');
  });

  it('reset vide les événements', () => {
    const logger = new CapturingWorkerLogger();
    logger.finalizerCompleted({ finalizedCount: 1, inspectedCount: 1, inconsistentCount: 0 });
    logger.reset();
    expect(logger.events).toHaveLength(0);
  });
});
