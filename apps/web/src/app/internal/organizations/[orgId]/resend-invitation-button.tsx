'use client';

import { useRef, useState } from 'react';
import { resendInvitationNotificationAction } from '@/app/actions/support';
import styles from './organization-support.module.css';

export function ResendInvitationButton({ invitationId }: { invitationId: string }) {
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Idempotence end-to-end (Chantier 16.1.1) : un UUID stable est créé pour UNE
  // intention de renvoi. Il est réutilisé si la même soumission est rejouée après
  // un timeout/échec réseau (pas de nouvelle notification en double), et renouvelé
  // après un succès (le clic suivant exprime une nouvelle intention => nouvelle
  // notification). Aucun fallback : le Core refuse un requestId vide/invalide.
  const supportRequestIdRef = useRef<string | null>(null);

  const handleResend = async () => {
    const reason = window.prompt(
      'Motif support obligatoire pour le renvoi de l’invitation (consigné dans l’audit) :',
    );
    if (!reason || !reason.trim()) return;

    setLoading(true);
    setMsg(null);
    try {
      if (!supportRequestIdRef.current) {
        supportRequestIdRef.current = crypto.randomUUID();
      }
      const res = await resendInvitationNotificationAction(
        invitationId,
        reason.trim(),
        supportRequestIdRef.current,
      );
      if (res.ok) {
        // Succès : l'intention est consommée, le prochain clic en crée une nouvelle.
        supportRequestIdRef.current = null;
        setMsg('✅ Renvoi programmé avec succès.');
      } else {
        // Échec métier : le même UUID reste réutilisable pour rejouer la soumission.
        setMsg(`❌ Échec: ${res.message}`);
      }
    } catch {
      // Timeout / erreur réseau : rejouer réutilisera le même UUID (idempotent).
      setMsg('❌ Erreur inattendue. Vous pouvez rejouer le renvoi sans risque de doublon.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
      <button type="button" className={styles.actionBtn} onClick={handleResend} disabled={loading}>
        {loading ? 'Renvoi en cours...' : '🔄 Renvoyer email'}
      </button>
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
