'use client';

import { useState } from 'react';
import { retryNotificationAction, cancelNotificationAction } from '@/app/actions/support';
import styles from './notifications-support.module.css';

export function NotificationActionButtons({
  notificationId,
  status,
}: {
  notificationId: string;
  status: string;
}) {
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const handleRetry = async () => {
    const reason = window.prompt('Motif support pour relancer la notification (audit) :');
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
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
      {status === 'FAILED' && (
        <button
          type="button"
          className={styles.actionBtn}
          onClick={handleRetry}
          disabled={loading}
        >
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

      {msg && <span style={{ fontSize: '0.75rem', color: msg.startsWith('✅') ? '#4ade80' : '#f87171' }}>{msg}</span>}
    </div>
  );
}
