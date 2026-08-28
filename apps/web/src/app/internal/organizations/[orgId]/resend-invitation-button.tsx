'use client';

import { useState } from 'react';
import { resendInvitationNotificationAction } from '@/app/actions/support';
import styles from './organization-support.module.css';

export function ResendInvitationButton({ invitationId }: { invitationId: string }) {
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const handleResend = async () => {
    const reason = window.prompt('Motif support obligatoire pour le renvoi de l’invitation (consigné dans l’audit) :');
    if (!reason || !reason.trim()) return;

    setLoading(true);
    setMsg(null);
    try {
      const res = await resendInvitationNotificationAction(invitationId, reason.trim());
      if (res.ok) {
        setMsg('✅ Renvoi programmé avec succès.');
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
        onClick={handleResend}
        disabled={loading}
      >
        {loading ? 'Renvoi en cours...' : '🔄 Renvoyer email'}
      </button>
      {msg && <span style={{ fontSize: '0.75rem', color: msg.startsWith('✅') ? '#4ade80' : '#f87171' }}>{msg}</span>}
    </div>
  );
}
