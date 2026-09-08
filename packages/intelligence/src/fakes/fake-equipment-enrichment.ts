import { createHash } from 'node:crypto';
import type {
  EquipmentEnrichmentInput,
  EquipmentEnrichmentProposal,
} from '../schemas/equipment-enrichment';
import type {
  EquipmentEnrichmentPort,
  EquipmentEnrichmentExecutionResult,
  EnrichmentExecutionMetadata,
} from '../ports/equipment-enrichment';
import { confident, abstain } from '../schemas/confidence';

/**
 * Proposition par défaut réaliste d'un VTT électrique pour les tests.
 */
export const DEFAULT_FAKE_BIKE_PROPOSAL: EquipmentEnrichmentProposal = {
  brand: confident('Specialized', 0.99, 'Logo Specialized bien visible sur le tube diagonal'),
  model: confident('Turbo Levo Comp Alloy', 0.95, 'Forme du cadre et inscriptions conformes au modèle 2024'),
  categorySlug: confident('bike', 0.99, 'Vélo tout terrain'),
  subtype: confident('electric_mountain', 0.98, 'Moteur central et batterie intégrée'),
  frameSize: confident('M', 0.85, 'Sticker taille M visible près du tube de selle'),
  specifications: confident(
    {
      motor: 'Specialized 2.2',
      batteryWh: 700,
      drivetrain: 'SRAM GX Eagle 12 vitesses',
      brakes: 'SRAM Code R 4 pistons',
      wheelSize: '29"',
    },
    0.92,
    'Composants SRAM et bloc moteur identifiés',
  ),
  marketingDescriptionFr: confident(
    'Le Specialized Turbo Levo Comp Alloy est le VTT électrique de référence pour explorer la montagne en toute sérénité. Équipé du moteur Specialized 2.2 fluide et puissant couplé à une batterie généreuse de 700 Wh, il vous emmènera sur les sentiers les plus engagés avec un confort et un contrôle exceptionnels.',
    0.95,
  ),
  marketingDescriptionEn: confident(
    'The Specialized Turbo Levo Comp Alloy is the benchmark electric mountain bike for exploring trails with confidence. Featuring the smooth and powerful Specialized 2.2 motor paired with a generous 700 Wh battery, it tackles challenging terrain with outstanding control and comfort.',
    0.95,
  ),
  suggestedCondition: confident('GOOD', 0.88, 'Très bon état général, légères traces cosmétiques normales'),
  detectedPhotoSlot: confident('HERO_PROFILE', 0.95, 'Vue de profil latérale complète côté transmission'),
  generalObservations: 'Vélo complet et prêt pour la location.',
};

/**
 * Proposition avec abstention réaliste (modèle incertain, taille inconnue).
 */
export const ABSTAINING_FAKE_BIKE_PROPOSAL: EquipmentEnrichmentProposal = {
  brand: confident('Trek', 0.96, 'Logo Trek lisible sur le cadre'),
  model: confident('Marlin probable', 0.65, 'Géométrie semi-rigide Trek, modèle exact incertain'),
  categorySlug: confident('bike', 0.99, 'Vélo tout terrain'),
  subtype: confident('mountain', 0.9, 'VTT musculaire classique'),
  frameSize: abstain('Aucune étiquette de taille ni indication géométrique lisible sur la photo'),
  specifications: confident(
    {
      wheelSize: '29"',
    },
    0.7,
  ),
  marketingDescriptionFr: confident(
    'VTT Trek semi-rigide idéal pour les balades sportives et les chemins de campagne.',
    0.8,
  ),
  marketingDescriptionEn: confident(
    'Trek hardtail mountain bike, perfect for trail rides and backcountry adventures.',
    0.8,
  ),
  suggestedCondition: confident('GOOD', 0.8, 'État visuel correct'),
  detectedPhotoSlot: confident('THREE_QUARTER_FRONT', 0.9, 'Vue 3/4 avant'),
  generalObservations: 'Taille et spécifications précises à vérifier par le loueur.',
};

export interface FakeEquipmentEnrichmentOptions {
  readonly proposal?: EquipmentEnrichmentProposal;
  readonly shouldFail?: boolean;
  readonly failureError?: Error;
  readonly latencyMs?: number;
}

/**
 * Implémentation de test déterministe d'EquipmentEnrichmentPort.
 *
 * Permet d'exécuter l'intégralité de la chaîne CI et les tests d'intégration
 * sans aucun appel réseau vers un fournisseur LLM externe et à coût zéro.
 */
export class FakeEquipmentEnrichmentProvider implements EquipmentEnrichmentPort {
  private customProposal: EquipmentEnrichmentProposal | null = null;
  private shouldFail: boolean;
  private failureError: Error;
  private latencyMs: number;
  public callCount = 0;
  public lastInput: EquipmentEnrichmentInput | null = null;

  constructor(options: FakeEquipmentEnrichmentOptions = {}) {
    this.customProposal = options.proposal ?? null;
    this.shouldFail = options.shouldFail ?? false;
    this.failureError = options.failureError ?? new Error('Erreur simulée du fournisseur IA');
    this.latencyMs = options.latencyMs ?? 10;
  }

  setProposal(proposal: EquipmentEnrichmentProposal | null): void {
    this.customProposal = proposal;
  }

  setShouldFail(shouldFail: boolean, error?: Error): void {
    this.shouldFail = shouldFail;
    if (error) this.failureError = error;
  }

  async enrichEquipment(
    input: EquipmentEnrichmentInput,
  ): Promise<EquipmentEnrichmentExecutionResult> {
    this.callCount++;
    this.lastInput = input;

    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }

    if (this.shouldFail) {
      throw this.failureError;
    }

    const proposal = this.customProposal ?? DEFAULT_FAKE_BIKE_PROPOSAL;

    const hash = createHash('sha256');
    hash.update(input.organizationId);
    for (const img of input.images) {
      if (img.url) hash.update(img.url);
      if (img.base64) hash.update(img.base64.slice(0, 100));
    }
    if (input.contextHint) hash.update(input.contextHint);
    const inputFingerprint = hash.digest('hex');

    const metadata: EnrichmentExecutionMetadata = {
      provider: 'fake-deterministic',
      model: 'fake-vlm-v1',
      promptVersion: 'p0-equipment-v1.0',
      providerRequestId: `fake-req-${Date.now()}`,
      latencyMs: this.latencyMs,
      inputUnits: input.images.length * 1000,
      outputUnits: 450,
      costMicrounits: 2500, // 0.0025 €
    };

    return {
      proposal,
      metadata,
      inputFingerprint,
    };
  }
}
