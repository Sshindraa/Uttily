# Scheduler cron staging

Ce Worker Cloudflare remplace uniquement les Cron Jobs Vercel incompatibles
avec le plan Hobby. Il déclenche chaque minute les quatre routes HTTP cron de
l'application Vercel staging, avec le même `CRON_SECRET` partagé.

## Développement et déploiement

```bash
pnpm --filter @uttily/staging-cron test
pnpm dlx wrangler login
pnpm dlx wrangler secret put CRON_SECRET --config apps/staging-cron/wrangler.toml
pnpm dlx wrangler deploy --config apps/staging-cron/wrangler.toml
```

Le secret n'est jamais écrit dans Git, dans `wrangler.toml` ou dans les logs.
Il doit être identique à `CRON_SECRET` du projet Vercel `uttily-staging`.
Le Worker n'utilise aucune clé Stripe, Clerk, Neon, R2 ou Resend.
