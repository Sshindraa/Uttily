import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from '@uttily/database';
import {
  auditLog,
  notifications,
  organizationInvitations,
  organizations,
} from '@uttily/database';
import type { SupportActionContext } from '../types';
import { NotificationActionError } from './retry-notification';

export interface ResendInvitationNotificationInput extends SupportActionContext {
  readonly invitationId: string;
  readonly supportRequestId?: string | undefined;
}

/**
 * Use case Support : Renvoi d'une notification d'invitation d'équipe (Chantier 16.1).
 *
 * Invariants de sécurité :
 * 1. L'invitation doit être PENDING et non expirée.
 * 2. L'organisation doit être ACTIVE.
 * 3. Préserve l'historique complet : ne modifie JAMAIS l'ancienne notification SENT/FAILED.
 * 4. Crée une NOUVELLE notification PENDING avec une clé d'idempotence propre.
 * 5. L'action support est idempotente via `supportRequestId`.
 * 6. Zéro secret, token ou token_hash dans les métadonnées ou le journal d'audit.
 */
export async function resendInvitationNotificationSupport(
  db: DatabaseClient,
  input: ResendInvitationNotificationInput,
): Promise<{ ok: true; invitationId: string; notificationId: string }> {
  const { invitationId, actorUserId, reason, supportRequestId } = input;

  if (!reason || reason.trim().length === 0) {
    throw new NotificationActionError(
      'SUPPORT_ACTION_INVALID_STATE',
      'Un motif explicite est obligatoire pour renvoyer une invitation.',
    );
  }

  return db.transaction(async (tx) => {
    const [invitation] = await tx
      .select()
      .from(organizationInvitations)
      .where(eq(organizationInvitations.id, invitationId))
      .for('update')
      .limit(1);

    if (!invitation) {
      throw new NotificationActionError('NOT_FOUND', 'Invitation introuvable.');
    }

    if (invitation.status !== 'PENDING') {
      throw new NotificationActionError(
        'SUPPORT_ACTION_INVALID_STATE',
        `Impossible de renvoyer une invitation avec le statut ${invitation.status}.`,
      );
    }

    const now = new Date();
    if (invitation.expiresAt <= now) {
      throw new NotificationActionError(
        'SUPPORT_ACTION_INVALID_STATE',
        'Cette invitation est expirée.',
      );
    }

    const [org] = await tx
      .select({
        id: organizations.id,
        legalName: organizations.legalName,
        publicDisplayName: organizations.publicDisplayName,
        status: organizations.status,
      })
      .from(organizations)
      .where(eq(organizations.id, invitation.organizationId))
      .limit(1);

    if (!org || org.status !== 'ACTIVE') {
      throw new NotificationActionError(
        'SUPPORT_ACTION_INVALID_STATE',
        'L’organisation associée à cette invitation n’est pas active.',
      );
    }

    const newIdempotencyKey = supportRequestId
      ? `invitation_resend:${invitation.id}:${supportRequestId.trim()}`
      : `invitation_resend:${invitation.id}:${randomUUID()}`;

    // Vérifier l'idempotence de l'action support
    const [existingResend] = await tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.idempotencyKey, newIdempotencyKey))
      .limit(1);

    if (existingResend) {
      return { ok: true, invitationId: invitation.id, notificationId: existingResend.id };
    }

    // Créer une NOUVELLE notification PENDING sans altérer l'historique
    const [newNotif] = await tx
      .insert(notifications)
      .values({
        organizationId: invitation.organizationId,
        template: 'ORGANIZATION_INVITATION',
        recipient: invitation.email,
        status: 'PENDING',
        idempotencyKey: newIdempotencyKey,
        scheduledFor: now,
        nextAttemptAt: now,
        attemptCount: 0,
        metadata: {
          invitationId: invitation.id,
          organizationName: org.publicDisplayName ?? org.legalName ?? 'Uttily',
          roleName: invitation.role,
        },
      })
      .returning({ id: notifications.id });

    if (!newNotif) {
      throw new NotificationActionError(
        'SUPPORT_ACTION_INVALID_STATE',
        'Échec de création de la notification de renvoi.',
      );
    }

    // Audit append-only
    await tx.insert(auditLog).values({
      actorUserId,
      action: 'SUPPORT_INVITATION_NOTIFICATION_RESEND',
      targetType: 'organization_invitation',
      targetId: invitationId,
      metadata: {
        reason: reason.trim(),
        supportRequestId: supportRequestId ?? null,
        notificationId: newNotif.id,
        idempotencyKey: newIdempotencyKey,
        organizationId: invitation.organizationId,
        recipient: invitation.email,
        role: invitation.role,
      },
    });

    return { ok: true, invitationId: invitation.id, notificationId: newNotif.id };
  });
}
