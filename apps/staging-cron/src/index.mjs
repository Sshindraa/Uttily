export const CRON_PATHS = Object.freeze([
  '/api/cron/expire-holds',
  '/api/cron/reconcile-payments',
  '/api/cron/process-compensations',
  '/api/cron/process-refund-requests',
]);

const USER_AGENT = 'uttily-staging-cron/1';

export function resolveCronTargetUrl(rawTargetUrl) {
  if (!rawTargetUrl || !rawTargetUrl.trim()) {
    throw new Error('CRON_TARGET_URL est requis.');
  }

  let targetUrl;
  try {
    targetUrl = new URL(rawTargetUrl);
  } catch {
    throw new Error('CRON_TARGET_URL doit être une URL absolue.');
  }

  if (
    targetUrl.protocol !== 'https:' ||
    targetUrl.username ||
    targetUrl.password ||
    targetUrl.hostname === 'localhost' ||
    targetUrl.hostname === '127.0.0.1' ||
    targetUrl.hostname === '::1'
  ) {
    throw new Error('CRON_TARGET_URL doit être une URL HTTPS publique sans credentials.');
  }

  targetUrl.pathname = targetUrl.pathname.replace(/\/+$/, '');
  targetUrl.search = '';
  targetUrl.hash = '';
  return targetUrl.toString().replace(/\/$/, '');
}

function resolveCronSecret(rawSecret) {
  if (!rawSecret || !rawSecret.trim()) {
    throw new Error('CRON_SECRET est requis.');
  }
  return rawSecret;
}

export async function runScheduledJobs(env, fetchImpl = fetch, logger = console) {
  const targetUrl = resolveCronTargetUrl(env.CRON_TARGET_URL);
  const cronSecret = resolveCronSecret(env.CRON_SECRET);
  const results = [];

  for (const path of CRON_PATHS) {
    const url = `${targetUrl}${path}`;
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${cronSecret}`,
          'User-Agent': USER_AGENT,
        },
      });
      const result = { path, status: response.status, ok: response.ok };
      results.push(result);
      if (result.ok) {
        logger.info?.('uttily_staging_cron_result', result);
      } else {
        logger.error?.('uttily_staging_cron_result', result);
      }
    } catch {
      const result = { path, status: 0, ok: false };
      results.push(result);
      logger.error?.('uttily_staging_cron_request_failed', result);
    }
  }

  if (results.some((result) => !result.ok)) {
    throw new Error('Au moins une route cron staging a échoué.');
  }

  return results;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/health') {
      return new Response('Not Found', { status: 404 });
    }

    return new Response('ok', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },

  async scheduled(_controller, env, executionContext) {
    executionContext.waitUntil(runScheduledJobs(env));
  },
};
