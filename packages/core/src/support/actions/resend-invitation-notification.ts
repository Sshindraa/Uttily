import { eq } from 'drizzle-orm';
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
}

/**
 * Use case Support : Renvoi de la notification d'invitation d'équipe.
 * Ne régénère pas de secret et n'expose aucun bearer token brut.
 */
export async function resendInvitationNotificationSupport(
  db: DatabaseClient,
  input: ResendInvitationNotificationInput,
): Promise<{ ok: true; invitationId: string }> {
  const { invitationId, actorUserId, reason } = input;

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
        legalName: organizations.legalName,
        publicDisplayName: organizations.publicDisplayName,
      })
      .from(organizations)
      .where(eq(organizations.id, invitation.organizationId))
      .limit(1);

    const idempotencyKey = `invitation:${invitation.id}`;

    // Vérifier si une notification existe déjà
    const [existingNotif] = await tx
      .select()
      .from(notifications)
      .where(eq(notifications.idempotencyKey, idempotencyKey))
      .limit(1);

    if (existingNotif) {
      await tx
        .update(notifications)
        .set({
          status: 'PENDING',
          nextAttemptAt: now,
          leaseToken: null,
          leaseUntil: null,
          failureCode: null,
          requiresManualReview: false,
          updatedAt: now,
        })
        .where(eq(notifications.id, existingNotif.id));
    } else {
      await tx.insert(notifications).values({
        organizationId: invitation.organizationId,
        template: 'ORGANIZATION_INVITATION',
        recipient: invitation.email,
        status: 'PENDING',
        idempotencyKey,
        metadata: {
          organizationName: org?.publicDisplayName ?? org?.legalName ?? 'Uttily',
          roleName: invitation.role,
          invitationId: invitation.id,
        },
      });
    }

    // Audit append-only
    await tx.insert(auditLog).values({
      actorUserId,
      action: 'SUPPORT_INVITATION_NOTIFICATION_RESEND',
      targetType: 'organization_invitation',
      targetId: invitationId,
      metadata: {
        reason: reason?.trim() || 'Renvoi manuel invitation support',
        organizationId: invitation.organizationId,
        recipient: invitation.email,
        role: invitation.role,
      },
    });

    return { ok: true, invitationId };
  });
}
