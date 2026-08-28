import { describe, expect, it, vi } from 'vitest';
import { emitOperationalLog } from './operational-logger';

describe('emitOperationalLog', () => {
  it('émet uniquement le contrat structuré sûr', () => {
    const sink = vi.fn();

    const inputWithUnexpectedFields = {
      operation: 'payment_reconciliation',
      outcome: 'degraded',
      durationMs: 42.8,
      counts: {
        due: 2,
        failed: 1,
        email: 1,
      },
      errorCode: 'PROVIDER_RESULT_INVALID',
      runId: 'run-2026-08-28-01',
      payload: { email: 'client@example.com', token: 'secret' },
    } as Parameters<typeof emitOperationalLog>[0];

    emitOperationalLog(inputWithUnexpectedFields, sink);

    expect(sink).toHaveBeenCalledOnce();
    const event = JSON.parse(sink.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(event).toMatchObject({
      operation: 'payment_reconciliation',
      outcome: 'degraded',
      durationMs: 42,
      errorCode: 'PROVIDER_RESULT_INVALID',
      runId: 'run-2026-08-28-01',
      counts: { due: 2, failed: 1 },
    });
    expect(event).not.toHaveProperty('email');
    expect(event).not.toHaveProperty('payload');
    expect(JSON.stringify(event)).not.toContain('client@example.com');
    expect(JSON.stringify(event)).not.toContain('secret');
  });

  it('ne laisse pas une erreur du sink casser le métier', () => {
    expect(() =>
      emitOperationalLog(
        { operation: 'notifications', outcome: 'success', counts: { sent: 1 } },
        () => {
          throw new Error('sink indisponible');
        },
      ),
    ).not.toThrow();
  });

  it('normalise les codes et compteurs non sûrs sans sérialiser leur valeur', () => {
    const sink = vi.fn();

    emitOperationalLog(
      {
        operation: 'refunds',
        outcome: 'failed',
        errorCode: 'raw provider error with secret',
        counts: { failed: -1, due: Number.NaN },
      },
      sink,
    );

    const event = JSON.parse(sink.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(event.errorCode).toBe('UNKNOWN_ERROR');
    expect(event).not.toHaveProperty('counts');
  });
});
