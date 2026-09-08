import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  OpenRouterIntentCompilerProvider,
} from '../packages/intelligence/src/index.ts';

const envLocalPath = resolve(process.cwd(), '.env.local');
if (existsSync(envLocalPath)) {
  const content = readFileSync(envLocalPath, 'utf8');
  for (const line of content.split('\n')) {
    const match = line.match(/^\s*([\w_]+)\s*=\s*(.*)?\s*$/);
    if (match && match[1] && match[2]) {
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

const query = process.argv.slice(2).join(' ') || 'On est 2 adultes et un enfant de 6 ans, on veut faire le tour du lac d Annecy ce samedi en velos electriques';

console.log(`\n🔍 Test Live OpenRouter Intent Compiler`);
console.log(`💬 Requête : "${query}"\n`);

async function run() {
  const provider = new OpenRouterIntentCompilerProvider({
    model: process.env.OPENROUTER_INTENT_MODEL || 'google/gemini-3.8-flash',
  });

  const startTime = Date.now();
  const result = await provider.compileIntent({
    rawQuery: query,
    locale: 'fr',
    userContext: {
      currentDateTimeIso: new Date().toISOString(),
      availableDestinations: [
        { publicId: 'dest-annecy-123', label: 'Annecy', slug: 'annecy' },
        { publicId: 'dest-chamonix-456', label: 'Chamonix', slug: 'chamonix' },
        { publicId: 'dest-arcachon-789', label: 'Bassin d’Arcachon', slug: 'arcachon' },
      ],
      availableCategories: [
        { id: 'cat-bike-1', name: 'Vélo & Mobilité', slug: 'bike' },
        { id: 'cat-kayak-2', name: 'Kayak & Pirogue', slug: 'kayak' },
        { id: 'cat-paddle-3', name: 'Stand-up Paddle', slug: 'paddleboard' },
      ],
    },
  });

  const duration = Date.now() - startTime;
  console.log(`⏱️ Temps d'exécution : ${duration}ms (modèle : ${result.model})`);
  console.log(`\n📋 Proposition extraite :`);
  console.log(JSON.stringify(result.proposal, null, 2));
}

run().catch((err) => {
  console.error('\n❌ Erreur :', err.message);
  process.exit(1);
});
