import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { OpenRouterEquipmentEnrichmentProvider } from '../packages/intelligence/src/index.ts';

// Chargement manuel de .env.local
const envLocalPath = resolve(process.cwd(), '.env.local');
if (existsSync(envLocalPath)) {
  const content = readFileSync(envLocalPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

const target = process.argv[2] || 'apps/web/public/images/home/cycling-sunset.jpg';
let imagePayload;

if (target.startsWith('http://') || target.startsWith('https://')) {
  console.log('📸 Image distante testée :', target);
  imagePayload = { url: target, mimeType: 'image/jpeg' };
} else {
  const filePath = resolve(process.cwd(), target);
  if (!existsSync(filePath)) {
    console.error('Fichier image introuvable :', filePath);
    process.exit(1);
  }
  console.log('📸 Image locale testée :', target);
  const base64 = readFileSync(filePath).toString('base64');
  const mimeType = target.endsWith('.png') ? 'image/png' : target.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  imagePayload = { base64, mimeType };
}

console.log('🚀 Test Scan & List avec OpenRouter (google/gemini-3.8-flash)...');

const provider = new OpenRouterEquipmentEnrichmentProvider();

const input = {
  organizationId: 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d',
  images: [imagePayload],
  locale: 'fr',
  contextHint: 'Vélo de balade / VTT pour cyclotourisme',
};

console.log('\n⏳ Envoi de la requête à OpenRouter...');
const startTime = Date.now();

try {
  const result = await provider.enrichEquipment(input);
  const totalMs = Date.now() - startTime;

  console.log(`\n✅ Réponse reçue en ${totalMs} ms (Latence provider: ${result.metadata.latencyMs} ms) !`);
  console.log('🏷️  Tokens :', result.metadata.inputUnits, 'in /', result.metadata.outputUnits, 'out');
  console.log('💰 Coût estimé :', (result.metadata.costMicrounits / 10000).toFixed(4), 'centimes d’euro');

  console.log('\n--- FICHE TECHNIQUE EXTRAITE PAR L’IA ---');
  console.log('Marque       :', result.proposal.brand.value, `(${Math.round(result.proposal.brand.confidence * 100)}%)`);
  console.log('Modèle       :', result.proposal.model.value, `(${Math.round(result.proposal.model.confidence * 100)}%)`);
  console.log('Catégorie    :', result.proposal.categorySlug.value, `(${Math.round(result.proposal.categorySlug.confidence * 100)}%)`);
  console.log('Sous-type    :', result.proposal.subtype.value, `(${Math.round(result.proposal.subtype.confidence * 100)}%)`);
  console.log('Taille cadre :', result.proposal.frameSize.value ?? 'Non déterminée (abstention)', `(${Math.round(result.proposal.frameSize.confidence * 100)}%)`);
  console.log('Angle photo  :', result.proposal.detectedPhotoSlot.value);
  console.log('État suggéré :', result.proposal.suggestedCondition.value);
  console.log('\nSpécifications techniques :');
  console.dir(result.proposal.specifications.value, { depth: null });
  console.log('\nDescription commerciale (FR) :');
  console.log(result.proposal.marketingDescriptionFr.value);
  console.log('\nObservations :');
  console.log(result.proposal.generalObservations);

} catch (err) {
  console.error('\n❌ Erreur lors du test :', err);
  process.exit(1);
}
