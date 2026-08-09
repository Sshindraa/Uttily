/**
 * @uttily/core — Use case idempotent de création de snapshot de rendu (G5C, ADR-013).
 *
 * Ordre des verrous (documenté) :
 * 1. BEGIN TRANSACTION
 * 2. SELECT FOR UPDATE sur outbox_events WHERE id = outboxEventId
 *    AND organization_id = ... -> sérialise la création du snapshot pour cet événement
 * 3. Vérifier si un snapshot existe déjà pour outbox_event_id
 * 4. Si oui : valider sa forme runtime via parseDocumentRenderSnapshotV1,
 *    recouper les cohérences DB, le retourner sans relire les données métier
 * 5. Sinon : charger les autorités DB (LoadedDocumentRenderDataV1), assembler
 *    le snapshot complet avec sourceOutboxEventId et capturedAt, valider via
 *    parseDocumentRenderSnapshotV1, INSERT
 * 6. COMMIT
 *
 * Concurrence :
 * - deux appels simultanés sur le même événement : le second attend le premier
 *   sur le SELECT FOR UPDATE, puis trouve le snapshot existant et le retourne
 * - une seule ligne doit exister (UNIQUE(outbox_event_id) + append-only)
 * - aucun deadlock (verrou unique sur outbox_events)
 * - aucun outbox_effect créé dans G5C
 * - aucun statut outbox modifié
 * - aucune lease posée
 */

import { sql } from 'drizzle-orm';
import type { DatabaseClient, DbExecutor } from '@uttily/database';
import { DocumentRenderError } from './errors';
import { parseBookingConfirmedV1 } from './booking-confirmed-parser';
import { loadDocumentRenderData, toCanonicalIsoTimestamp } from './load-document-render-data';
import { parseDocumentRenderSnapshotV1 } from './parse-snapshot';
import { SNAPSHOT_VERSION } from './snapshot-types';
import type { DocumentRenderSnapshotV1 } from './snapshot-types';

export interface GetOrCreateSnapshotInput {
  readonly outboxEventId: string;
  readonly organizationId: string;
}

export interface GetOrCreateSnapshotResult {
  readonly snapshotId: string;
  readonly snapshot: DocumentRenderSnapshotV1;
  readonly createdAt: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Core logique acceptant un DbExecutor (client ou transaction).
 *
 * Cette fonction est appelée par le wrapper public qui ouvre sa propre
 * transaction, ET par le pipeline documentaire (G5D) qui l'appelle dans une
 * transaction existante (Phase A). Aucune transaction imbriquée.
 */
export async function getOrCreateDocumentRenderSnapshotInTx(
  tx: DbExecutor,
  input: GetOrCreateSnapshotInput,
): Promise<GetOrCreateSnapshotResult> {
  if (!UUID_RE.test(input.outboxEventId)) {
    throw new DocumentRenderError('VALIDATION', 'outboxEventId n est pas un UUID valide');
  }
  if (!UUID_RE.test(input.organizationId)) {
    throw new DocumentRenderError('VALIDATION', 'organizationId n est pas un UUID valide');
  }

  // 1. Verrouiller outbox_events (SELECT FOR UPDATE sérialise la création).
  const eventRows = await tx.execute(sql`
    SELECT id, organization_id, aggregate_type, aggregate_id, event_type, event_version, payload
    FROM "outbox_events"
    WHERE "id" = ${input.outboxEventId}::uuid
      AND "organization_id" = ${input.organizationId}::uuid
    FOR UPDATE
  `);
  if (eventRows.length === 0) {
    throw new DocumentRenderError(
      'EVENT_NOT_FOUND',
      'evenement outbox introuvable ou cross-organisation',
    );
  }

  const eventRow = eventRows[0] as Record<string, unknown>;

  // 2. Valider BOOKING_CONFIRMED.v1.
  const parsed = parseBookingConfirmedV1({
    id: eventRow['id'] as string,
    organizationId: eventRow['organization_id'] as string,
    aggregateType: eventRow['aggregate_type'] as string,
    aggregateId: eventRow['aggregate_id'] as string,
    eventType: eventRow['event_type'] as string,
    eventVersion: eventRow['event_version'] as string,
    payload: eventRow['payload'],
  });

  // 3. Chercher un snapshot existant.
  const existing = await tx.execute(sql`
    SELECT id, organization_id, booking_id, snapshot, template_version, created_at
    FROM "document_render_snapshots"
    WHERE "outbox_event_id" = ${input.outboxEventId}::uuid
      AND "organization_id" = ${input.organizationId}::uuid
    LIMIT 1
  `);
  if (existing.length > 0) {
    const row = existing[0] as Record<string, unknown>;
    // Cohérences DB sur la ligne existante.
    if (row['organization_id'] !== input.organizationId) {
      throw new DocumentRenderError('SNAPSHOT_INVARIANT', 'snapshot existant cross-organisation');
    }
    if (row['booking_id'] !== parsed.payload.bookingId) {
      throw new DocumentRenderError('SNAPSHOT_INVARIANT', 'snapshot existant booking_id mismatch');
    }
    const templateVersion = row['template_version'];
    if (templateVersion !== SNAPSHOT_VERSION) {
      throw new DocumentRenderError('SNAPSHOT_INVARIANT', 'template_version n est pas conforme');
    }
    // Validation runtime récursive stricte du snapshot stocké.
    const snapshot = parseDocumentRenderSnapshotV1(row['snapshot']);
    // Cohérences DB ↔ snapshot parsé.
    if (snapshot.sourceOutboxEventId !== input.outboxEventId) {
      throw new DocumentRenderError(
        'SNAPSHOT_INVARIANT',
        'snapshot existant sourceOutboxEventId mismatch',
      );
    }
    if (snapshot.organizationId !== input.organizationId) {
      throw new DocumentRenderError(
        'SNAPSHOT_INVARIANT',
        'snapshot existant organizationId mismatch',
      );
    }
    if (snapshot.bookingId !== row['booking_id']) {
      throw new DocumentRenderError('SNAPSHOT_INVARIANT', 'snapshot existant bookingId mismatch');
    }
    if (snapshot.snapshotVersion !== SNAPSHOT_VERSION) {
      throw new DocumentRenderError('SNAPSHOT_INVARIANT', 'snapshotVersion n est pas conforme');
    }
    return {
      snapshotId: row['id'] as string,
      snapshot,
      createdAt: toCanonicalIsoTimestamp(row['created_at'], 'snapshot.created_at'),
    };
  }

  // 4. Charger et recouper les autorités DB (sans sourceOutboxEventId/capturedAt).
  const loaded = await loadDocumentRenderData(tx, {
    organizationId: parsed.organizationId,
    bookingId: parsed.payload.bookingId,
    paymentId: parsed.payload.paymentId,
    draftId: parsed.payload.draftId,
  });

  // 5. Capturer le timestamp transactionnel et assembler le snapshot complet.
  const tsRows = await tx.execute(sql`SELECT transaction_timestamp() AS ts`);
  const tsValue = (tsRows[0] as Record<string, unknown>)['ts'];
  const capturedAt = toCanonicalIsoTimestamp(tsValue, 'capturedAt');

  const snapshot: DocumentRenderSnapshotV1 = {
    snapshotVersion: SNAPSHOT_VERSION,
    sourceOutboxEventId: input.outboxEventId,
    organizationId: loaded.organizationId,
    bookingId: loaded.bookingId,
    paymentId: loaded.paymentId,
    draftId: loaded.draftId,
    capturedAt,
    organization: loaded.organization,
    location: loaded.location,
    customer: loaded.customer,
    booking: loaded.booking,
    payment: loaded.payment,
    lines: loaded.lines,
    items: loaded.items,
  };

  // Valider le snapshot complet avant INSERT (défense en profondeur).
  parseDocumentRenderSnapshotV1(snapshot);

  // 6. INSERT document_render_snapshots.
  const inserted = await tx.execute(sql`
    INSERT INTO "document_render_snapshots" (
      "organization_id", "outbox_event_id", "booking_id",
      "snapshot", "template_version"
    ) VALUES (
      ${input.organizationId}::uuid,
      ${input.outboxEventId}::uuid,
      ${parsed.payload.bookingId}::uuid,
      ${JSON.stringify(snapshot)}::jsonb,
      'v1'
    )
    RETURNING "id", "created_at"
  `);
  const row = inserted[0] as Record<string, unknown>;
  return {
    snapshotId: row['id'] as string,
    snapshot,
    createdAt: toCanonicalIsoTimestamp(row['created_at'], 'snapshot.created_at'),
  };
}

/**
 * Use case idempotent de création de snapshot de rendu.
 *
 * Wrapper public qui ouvre sa propre transaction. Pour appeler dans une
 * transaction existante, utiliser getOrCreateDocumentRenderSnapshotInTx.
 */
export async function getOrCreateDocumentRenderSnapshot(
  db: DatabaseClient,
  input: GetOrCreateSnapshotInput,
): Promise<GetOrCreateSnapshotResult> {
  return await db.transaction(async (tx) => getOrCreateDocumentRenderSnapshotInTx(tx, input));
}
