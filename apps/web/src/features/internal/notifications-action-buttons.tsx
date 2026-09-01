'use client';

import { useState } from 'react';
import { retryNotificationAction, cancelNotificationAction } from '@/app/actions/support';
import styles from './notifications-support.module.css';

export function NotificationActionButtons({
  notificationId,
  status,
  failureCode,
  requiresManualReview,
}: {
  notificationId: string;
  status: string;
  failureCode?: string | null;
  requiresManualReview?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const isUncertainExpired = failureCode === 'PROVIDER_RESULT_UNCERTAIN_WINDOW_EXPIRED';
  const isRetryAllowed = status === 'FAILED' && !isUncertainExpired;

  const handleRetry = async () => {
    const promptText = requiresManualReview
      ? 'Motif support obligatoire pour relancer cette notification avec revue requise (audit) :'
      : 'Motif support obligatoire pour relancer la notification (audit) :';
    const reason = window.prompt(promptText);
    if (!reason || !reason.trim()) return;

    setLoading(true);
    setMsg(null);
    try {
      const res = await retryNotificationAction(notificationId, reason.trim());
      if (res.ok) {
        setMsg('✅ Relancé');
      } else {
        setMsg(`❌ ${res.message}`);
      }
    } catch {
      setMsg('❌ Erreur');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async () => {
    const reason = window.prompt('Motif support pour annuler la notification (audit) :');
    if (!reason || !reason.trim()) return;

    setLoading(true);
    setMsg(null);
    try {
      const res = await cancelNotificationAction(notificationId, reason.trim());
      if (res.ok) {
        setMsg('✅ Annulé');
      } else {
        setMsg(`❌ ${res.message}`);
      }
    } catch {
      setMsg('❌ Erreur');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
      {isUncertainExpired && (
        <span
          style={{
            fontSize: '0.75rem',
            padding: '0.2rem 0.4rem',
            background: 'var(--ut-color-support-danger-bg)',
            color: 'var(--ut-color-support-danger)',
            borderRadius: '4px',
            border: '1px solid var(--ut-color-support-danger-border)',
          }}
          title="Le délai de 24h est dépassé après tentative incertaine. Relance interdite pour éviter tout risque de double envoi."
        >
          🚫 Doublon interdit (délai expiré)
        </span>
      )}

      {isRetryAllowed && (
        <button type="button" className={styles.actionBtn} onClick={handleRetry} disabled={loading}>
          {loading ? '...' : '🔄 Relancer'}
        </button>
      )}

      {(status === 'FAILED' || status === 'PENDING') && (
        <button
          type="button"
          className={styles.cancelBtn}
          onClick={handleCancel}
          disabled={loading}
        >
          {loading ? '...' : '🚫 Annuler'}
        </button>
      )}

      {msg && (
        <span
          style={{
            fontSize: '0.75rem',
            color: msg.startsWith('✅')
              ? 'var(--ut-color-support-success)'
              : 'var(--ut-color-support-danger)',
          }}
        >
          {msg}
        </span>
      )}
    </div>
  );
}
