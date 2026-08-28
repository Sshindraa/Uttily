'use client';

import { useState } from 'react';
import { reconcilePaymentSupportAction } from '@/app/actions/support';
import styles from './payments-support.module.css';

export function ReconcilePaymentButton({ paymentId }: { paymentId: string }) {
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const handleReconcile = async () => {
    const reason = window.prompt('Motif support pour forcer la réconciliation immédiate (audit) :');
    if (!reason || !reason.trim()) return;

    setLoading(true);
    setMsg(null);
    try {
      const res = await reconcilePaymentSupportAction(paymentId, reason.trim());
      if (res.ok) {
        setMsg('✅ Réconciliation programmée.');
      } else {
        setMsg(`❌ ${res.message}`);
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
        onClick={handleReconcile}
        disabled={loading}
      >
        {loading ? 'Programmation...' : '⚡ Forcer réconciliation'}
      </button>
      {msg && (
        <span style={{ fontSize: '0.75rem', color: msg.startsWith('✅') ? '#4ade80' : '#f87171' }}>
          {msg}
        </span>
      )}
    </div>
  );
}
