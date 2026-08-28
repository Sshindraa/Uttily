'use client';

import { useState } from 'react';
import { retryNotificationAction } from '@/app/actions/support';
import styles from './booking-support.module.css';

export function RetryNotificationButton({ notificationId }: { notificationId: string }) {
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const handleRetry = async () => {
    const reason = window.prompt('Motif support pour la relance de la notification (consigné dans l’audit) :');
    if (!reason || !reason.trim()) return;

    setLoading(true);
    setMsg(null);
    try {
      const res = await retryNotificationAction(notificationId, reason.trim());
      if (res.ok) {
        setMsg('✅ Relance programmée.');
      } else {
        setMsg(`❌ Échec: ${res.message}`);
      }
    } catch {
      setMsg('❌ Erreur inattendue.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
      <button
        type="button"
        className={styles.actionBtn}
        onClick={handleRetry}
        disabled={loading}
      >
        {loading ? 'Relance...' : '🔄 Relancer'}
      </button>
      {msg && <span style={{ fontSize: '0.75rem', color: msg.startsWith('✅') ? '#4ade80' : '#f87171' }}>{msg}</span>}
    </div>
  );
}
