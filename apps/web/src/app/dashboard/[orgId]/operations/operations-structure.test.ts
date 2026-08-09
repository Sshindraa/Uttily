import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Tests structurels G4B : vérifient l'absence de patterns dangereux
// dans les fichiers de l'interface opérations.
// Ces tests ne dépendent pas d'une DB et s'exécutent rapidement.

const OPERATIONS_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'app',
  'dashboard',
  '[orgId]',
  'operations',
);

function readFile(relPath: string): string {
  return readFileSync(join(OPERATIONS_DIR, relPath), 'utf-8');
}

const G4B_FILES = [
  'page.tsx',
  'loading.tsx',
  '[bookingId]/page.tsx',
  '[bookingId]/loading.tsx',
  '[bookingId]/transition-action.tsx',
  '[bookingId]/condition-report-form.tsx',
  '[bookingId]/damage-report-form.tsx',
];

describe('G4B — tests structurels', () => {
  describe('aucun dangerouslySetInnerHTML', () => {
    for (const file of G4B_FILES) {
      it(`${file} ne contient pas dangerouslySetInnerHTML`, () => {
        const content = readFile(file);
        expect(content).not.toContain('dangerouslySetInnerHTML');
      });
    }
  });

  describe('aucun inventoryItemId envoyé par les formulaires', () => {
    // Les formulaires ne doivent jamais demander inventoryItemId au navigateur.
    // Seuls bookingId et bookingItemId sont des champs cachés légitimes.
    it('condition-report-form ne contient pas de champ inventoryItemId', () => {
      const content = readFile('[bookingId]/condition-report-form.tsx');
      expect(content).not.toMatch(/name=["']inventoryItemId["']/);
    });
    it('damage-report-form ne contient pas de champ inventoryItemId', () => {
      const content = readFile('[bookingId]/damage-report-form.tsx');
      expect(content).not.toMatch(/name=["']inventoryItemId["']/);
    });
    it('transition-action ne contient pas de champ inventoryItemId', () => {
      const content = readFile('[bookingId]/transition-action.tsx');
      expect(content).not.toMatch(/name=["']inventoryItemId["']/);
    });
  });

  describe("clés d'idempotence en champs cachés", () => {
    it('transition-action contient un champ hidden idempotencyKey', () => {
      const content = readFile('[bookingId]/transition-action.tsx');
      expect(content).toMatch(/name=["']idempotencyKey["']/);
    });
    it('condition-report-form contient un champ hidden idempotencyKey', () => {
      const content = readFile('[bookingId]/condition-report-form.tsx');
      expect(content).toMatch(/name=["']idempotencyKey["']/);
    });
    it('damage-report-form contient un champ hidden idempotencyKey', () => {
      const content = readFile('[bookingId]/damage-report-form.tsx');
      expect(content).toMatch(/name=["']idempotencyKey["']/);
    });
  });

  describe('organizationId injecté par bind, pas par FormData', () => {
    it("transition-action bind l'action avec orgId", () => {
      const content = readFile('[bookingId]/transition-action.tsx');
      expect(content).toMatch(/\.bind\(null,\s*orgId\)/);
      expect(content).not.toMatch(/name=["']organizationId["']/);
    });
    it("condition-report-form bind l'action avec orgId", () => {
      const content = readFile('[bookingId]/condition-report-form.tsx');
      expect(content).toMatch(/\.bind\(null,\s*orgId\)/);
      expect(content).not.toMatch(/name=["']organizationId["']/);
    });
    it("damage-report-form bind l'action avec orgId", () => {
      const content = readFile('[bookingId]/damage-report-form.tsx');
      expect(content).toMatch(/\.bind\(null,\s*orgId\)/);
      expect(content).not.toMatch(/name=["']organizationId["']/);
    });
  });

  describe('Client Components marqués use client', () => {
    it('transition-action.tsx commence par use client', () => {
      const content = readFile('[bookingId]/transition-action.tsx');
      expect(content.startsWith("'use client'")).toBe(true);
    });
    it('condition-report-form.tsx commence par use client', () => {
      const content = readFile('[bookingId]/condition-report-form.tsx');
      expect(content.startsWith("'use client'")).toBe(true);
    });
    it('damage-report-form.tsx commence par use client', () => {
      const content = readFile('[bookingId]/damage-report-form.tsx');
      expect(content.startsWith("'use client'")).toBe(true);
    });
  });

  describe('Server Components sans use client', () => {
    it("page.tsx (liste) n'est pas un Client Component", () => {
      const content = readFile('page.tsx');
      expect(content.startsWith("'use client'")).toBe(false);
    });
    it("[bookingId]/page.tsx (détail) n'est pas un Client Component", () => {
      const content = readFile('[bookingId]/page.tsx');
      expect(content.startsWith("'use client'")).toBe(false);
    });
  });

  describe("pas d'email client passé aux Client Components", () => {
    // Les Client Components ne doivent pas recevoir l'email client.
    it('[bookingId]/page.tsx ne passe pas customerEmail aux formulaires', () => {
      const content = readFile('[bookingId]/page.tsx');
      // L'email est affiché dans le Server Component mais ne doit pas être
      // passé en prop aux Client Components.
      // Vérifie que les props des Client Components ne contiennent pas customerEmail.
      const transitionMatch = content.match(/<TransitionAction[^>]*>/s);
      if (transitionMatch) {
        expect(transitionMatch[0]).not.toContain('customerEmail');
      }
      const conditionMatch = content.match(/<ConditionReportForm[^>]*>/s);
      if (conditionMatch) {
        expect(conditionMatch[0]).not.toContain('customerEmail');
      }
      const damageMatch = content.match(/<DamageReportForm[^>]*>/s);
      if (damageMatch) {
        expect(damageMatch[0]).not.toContain('customerEmail');
      }
    });
  });

  describe("aria-live pour les résultats d'action", () => {
    it('transition-action contient aria-live', () => {
      const content = readFile('[bookingId]/transition-action.tsx');
      expect(content).toContain('aria-live');
    });
    it('condition-report-form contient aria-live', () => {
      const content = readFile('[bookingId]/condition-report-form.tsx');
      expect(content).toContain('aria-live');
    });
    it('damage-report-form contient aria-live', () => {
      const content = readFile('[bookingId]/damage-report-form.tsx');
      expect(content).toContain('aria-live');
    });
  });

  describe('useFormStatus pour le pending', () => {
    it('transition-action utilise useFormStatus', () => {
      const content = readFile('[bookingId]/transition-action.tsx');
      expect(content).toContain('useFormStatus');
    });
    it('condition-report-form utilise useFormStatus', () => {
      const content = readFile('[bookingId]/condition-report-form.tsx');
      expect(content).toContain('useFormStatus');
    });
    it('damage-report-form utilise useFormStatus', () => {
      const content = readFile('[bookingId]/damage-report-form.tsx');
      expect(content).toContain('useFormStatus');
    });
  });

  describe('aria-describedby conditionnel sur les erreurs', () => {
    it('condition-report-form : aria-describedby du select ne contient pas -error en dur', () => {
      const content = readFile('[bookingId]/condition-report-form.tsx');
      // L'attribut ne doit pas référencer -error de façon statique/inconditionnelle.
      // Il doit utiliser une variable conditionnelle.
      expect(content).not.toMatch(/aria-describedby=\{[^}]*-error[^}]*\}/);
    });

    it('damage-report-form : aria-describedby du textarea ne contient pas -error en dur', () => {
      const content = readFile('[bookingId]/damage-report-form.tsx');
      expect(content).not.toMatch(/aria-describedby=\{[^}]*-error[^}]*\}/);
    });
  });
});
