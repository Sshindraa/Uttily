import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// G4B : les invariants de sécurité des opérations sont testés sur les
// composants canoniques de la feature, et non sur l'ancien chemin redirigé.
const OPERATIONS_DIR = join(__dirname, '..', '..', '..', '..', 'features', 'operations');

function readFile(relPath: string): string {
  return readFileSync(join(OPERATIONS_DIR, relPath), 'utf-8');
}

const OPERATION_FILES = [
  'booking-detail-view.tsx',
  'departure-flow.tsx',
  'return-flow.tsx',
  'no-show-flow.tsx',
  'substitution-flow.tsx',
  'cancellation-flow.tsx',
  'flow-drawer.tsx',
];

describe('G4B — invariants structurels des opérations', () => {
  it.each(OPERATION_FILES)('%s ne contient pas dangerouslySetInnerHTML', (file) => {
    expect(readFile(file)).not.toContain('dangerouslySetInnerHTML');
  });

  it.each(['departure-flow.tsx', 'return-flow.tsx', 'substitution-flow.tsx'])(
    '%s ne transmet pas inventoryItemId au navigateur',
    (file) => {
      expect(readFile(file)).not.toContain('inventoryItemId');
    },
  );

  it.each(['departure-flow.tsx', 'return-flow.tsx'])(
    '%s conserve les clés d’idempotence et le contexte de l’organisation',
    (file) => {
      const content = readFile(file);
      expect(content).toContain('crypto.randomUUID()');
      expect(content).toContain("append('bookingId'");
      expect(content).toContain("append('bookingItemId'");
      expect(content).toContain('orgId');
    },
  );

  it.each(['flow-drawer.tsx', 'cancellation-flow.tsx'])(
    '%s porte l’interaction modale accessible',
    (file) => {
      const content = readFile(file);
      expect(content.startsWith("'use client'")).toBe(true);
      expect(content).toContain('role="dialog"');
      expect(content).toContain('aria-modal="true"');
    },
  );

  it('ne passe pas customerEmail aux flux Client depuis la fiche serveur', () => {
    const content = readFile('booking-detail-view.tsx');
    expect(content).not.toMatch(/<(?:DepartureFlow|ReturnFlow|CancellationFlow)[^>]*customerEmail/);
  });

  it.each(['no-show-flow.tsx', 'substitution-flow.tsx'])(
    '%s conserve une confirmation accessible, une clé idempotente et le refresh serveur',
    (file) => {
      const content = readFile(file);
      expect(content.startsWith("'use client'")).toBe(true);
      expect(content).toContain('FlowDrawer');
      expect(content).toContain('crypto.randomUUID()');
      expect(content).toContain('router.refresh()');
    },
  );
});
