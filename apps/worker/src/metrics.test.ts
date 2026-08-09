/**
 * @uttily/worker — Tests unitaires du collecteur de métriques (G5F).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMetricsCollector } from './metrics';

describe('InMemoryMetricsCollector', () => {
  let metrics: InMemoryMetricsCollector;

  beforeEach(() => {
    metrics = new InMemoryMetricsCollector();
  });

  it('incWorkerCyclesTotal incrémente par outcome', () => {
    metrics.incWorkerCyclesTotal('success');
    metrics.incWorkerCyclesTotal('success');
    metrics.incWorkerCyclesTotal('failed');
    const snap = metrics.snapshot();
    expect(snap.workerCyclesTotal.success).toBe(2);
    expect(snap.workerCyclesTotal.failed).toBe(1);
  });

  it('incDocumentsClaimedTotal incrémente', () => {
    metrics.incDocumentsClaimedTotal(5);
    metrics.incDocumentsClaimedTotal(3);
    expect(metrics.snapshot().documentsClaimedTotal).toBe(8);
  });

  it('incDocumentsCompletedTotal incrémente', () => {
    metrics.incDocumentsCompletedTotal(3);
    expect(metrics.snapshot().documentsCompletedTotal).toBe(3);
  });

  it('incDocumentsFailedTotal incrémente', () => {
    metrics.incDocumentsFailedTotal(2);
    expect(metrics.snapshot().documentsFailedTotal).toBe(2);
  });

  it('incDocumentsRescheduledTotal incrémente', () => {
    metrics.incDocumentsRescheduledTotal(1);
    expect(metrics.snapshot().documentsRescheduledTotal).toBe(1);
  });

  it('incEmailsClaimedTotal incrémente', () => {
    metrics.incEmailsClaimedTotal(4);
    expect(metrics.snapshot().emailsClaimedTotal).toBe(4);
  });

  it('incEmailsSentTotal incrémente', () => {
    metrics.incEmailsSentTotal(2);
    expect(metrics.snapshot().emailsSentTotal).toBe(2);
  });

  it('incEmailsFailedTotal incrémente', () => {
    metrics.incEmailsFailedTotal(1);
    expect(metrics.snapshot().emailsFailedTotal).toBe(1);
  });

  it('incLeaseLostTotal incrémente par pipeline', () => {
    metrics.incLeaseLostTotal('documents', 2);
    metrics.incLeaseLostTotal('emails', 1);
    const snap = metrics.snapshot();
    expect(snap.leaseLostTotal.documents).toBe(2);
    expect(snap.leaseLostTotal.emails).toBe(1);
  });

  it('incAnomaliesTotal incrémente par pipeline et failureCode', () => {
    metrics.incAnomaliesTotal('documents', 'STORAGE_CHECKSUM_MISMATCH', 1);
    metrics.incAnomaliesTotal('documents', 'STORAGE_CHECKSUM_MISMATCH', 1);
    metrics.incAnomaliesTotal('emails', 'EMAIL_SEND_FAILED', 1);
    const snap = metrics.snapshot();
    expect(snap.anomaliesTotal.documents.STORAGE_CHECKSUM_MISMATCH).toBe(2);
    expect(snap.anomaliesTotal.emails.EMAIL_SEND_FAILED).toBe(1);
  });

  it('incCycleFailuresTotal incrémente par pipeline', () => {
    metrics.incCycleFailuresTotal('documents');
    metrics.incCycleFailuresTotal('emails');
    metrics.incCycleFailuresTotal('emails');
    const snap = metrics.snapshot();
    expect(snap.cycleFailuresTotal.documents).toBe(1);
    expect(snap.cycleFailuresTotal.emails).toBe(2);
  });

  it('snapshot retourne une structure sérialisable', () => {
    metrics.incWorkerCyclesTotal('success');
    metrics.incDocumentsCompletedTotal(1);
    const snap = metrics.snapshot();
    expect(() => JSON.stringify(snap)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(snap));
    expect(parsed.workerCyclesTotal.success).toBe(1);
    expect(parsed.documentsCompletedTotal).toBe(1);
  });

  it('reset réinitialise tous les compteurs', () => {
    metrics.incWorkerCyclesTotal('success');
    metrics.incDocumentsClaimedTotal(5);
    metrics.incAnomaliesTotal('documents', 'LEASE_LOST', 3);
    metrics.reset();
    const snap = metrics.snapshot();
    expect(snap.workerCyclesTotal.success).toBe(0);
    expect(snap.documentsClaimedTotal).toBe(0);
    expect(snap.anomaliesTotal.documents.LEASE_LOST).toBeUndefined();
  });

  it('les labels sont strictement bornés (pas de UUID/email en label)', () => {
    // Les méthodes n'acceptent que des types fermés : pipeline, outcome, failureCode.
    // Aucune méthode n'accepte un UUID, email, bookingId ou storageKey en label.
    // Cette vérification est statique (typage TypeScript) — ici on vérifie
    // que le snapshot ne contient que des clés bornées.
    metrics.incAnomaliesTotal('documents', 'UNKNOWN_ERROR', 1);
    const snap = metrics.snapshot();
    const anomalyKeys = Object.keys(snap.anomaliesTotal.documents);
    expect(anomalyKeys.every((k) => WORKER_FAILURE_CODES_SET.has(k))).toBe(true);
  });

  it('incFinalizer*Total incrémente les compteurs du finalizer', () => {
    metrics.incFinalizerFinalizedTotal(5);
    metrics.incFinalizerCutoffTotal(2);
    metrics.incFinalizerUncertainTotal(1);
    metrics.incFinalizerInconsistentTotal(3);
    const snap = metrics.snapshot();
    expect(snap.finalizerFinalizedTotal).toBe(5);
    expect(snap.finalizerCutoffTotal).toBe(2);
    expect(snap.finalizerUncertainTotal).toBe(1);
    expect(snap.finalizerInconsistentTotal).toBe(3);
  });

  it('incFinalizerFailedTotal incrémente par failureCode', () => {
    metrics.incFinalizerFailedTotal('finalizer', 'EMAIL_RETRY_WINDOW_EXPIRED');
    metrics.incFinalizerFailedTotal('finalizer', 'EMAIL_RETRY_WINDOW_EXPIRED');
    metrics.incFinalizerFailedTotal('finalizer', 'PROVIDER_RESULT_UNCERTAIN');
    const snap = metrics.snapshot();
    expect(snap.finalizerFailedTotal.EMAIL_RETRY_WINDOW_EXPIRED).toBe(2);
    expect(snap.finalizerFailedTotal.PROVIDER_RESULT_UNCERTAIN).toBe(1);
  });

  it('reset réinitialise les compteurs du finalizer', () => {
    metrics.incFinalizerFinalizedTotal(1);
    metrics.incFinalizerFailedTotal('finalizer', 'EMAIL_RETRY_WINDOW_EXPIRED');
    metrics.reset();
    const snap = metrics.snapshot();
    expect(snap.finalizerFinalizedTotal).toBe(0);
    expect(snap.finalizerFailedTotal.EMAIL_RETRY_WINDOW_EXPIRED).toBeUndefined();
  });
});

const WORKER_FAILURE_CODES_SET = new Set<string>([
  'PAYLOAD_MALFORMED',
  'STORAGE_PUT_FAILED',
  'STORAGE_CHECKSUM_MISMATCH',
  'STORAGE_NOT_FOUND',
  'RENDER_FAILED',
  'EMAIL_SEND_FAILED',
  'LEASE_LOST',
  'PROVIDER_RESULT_UNCERTAIN',
  'EMAIL_RETRY_WINDOW_EXPIRED',
  'UNKNOWN_ERROR',
]);
