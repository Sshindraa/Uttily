import { getEmailBrandConfig, type EmailBrandConfig } from '../email-brand';

export interface EmailLayoutOptions {
  title: string;
  preheader?: string;
  contentHtml: string;
  brand?: EmailBrandConfig;
}

export function renderEmailLayout(options: EmailLayoutOptions): string {
  const brand = options.brand ?? getEmailBrandConfig();
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(options.title)}</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #f3f7f8;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #465b5f;
      -webkit-font-smoothing: antialiased;
    }
    .wrapper {
      width: 100%;
      background-color: #f3f7f8;
      padding: 32px 16px;
      box-sizing: border-box;
    }
    .container {
      max-width: 580px;
      margin: 0 auto;
      background-color: #ffffff;
      border-radius: 16px;
      overflow: hidden;
      border: 1px solid #d1e1e5;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
    }
    .header {
      background: linear-gradient(135deg, #465b5f 0%, #1c2426 100%);
      padding: 24px 32px;
      text-align: left;
    }
    .brand {
      color: #ffffff;
      font-size: 20px;
      font-weight: 800;
      letter-spacing: -0.5px;
      text-decoration: none;
    }
    .brand span {
      color: #d1e1e5;
    }
    .body {
      padding: 32px;
    }
    .footer {
      padding: 24px 32px;
      background-color: #e8f0f2;
      border-top: 1px solid #d1e1e5;
      font-size: 12px;
      color: #546d72;
      line-height: 1.5;
      text-align: center;
    }
    .footer a {
      color: #465b5f;
      text-decoration: none;
    }
    h1 {
      margin: 0 0 16px 0;
      font-size: 22px;
      font-weight: 700;
      color: #465b5f;
      line-height: 1.3;
    }
    p {
      margin: 0 0 16px 0;
      font-size: 15px;
      line-height: 1.6;
      color: #2a3639;
    }
    .card {
      background-color: #f3f7f8;
      border-radius: 12px;
      border: 1px solid #d1e1e5;
      padding: 20px;
      margin: 20px 0;
    }
    .metric-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 8px;
      font-size: 14px;
    }
    .metric-row:last-child {
      margin-bottom: 0;
    }
    .metric-label {
      color: #546d72;
    }
    .metric-value {
      font-weight: 600;
      color: #465b5f;
    }
    .btn {
      display: inline-block;
      background-color: #465b5f;
      color: #ffffff !important;
      padding: 12px 24px;
      border-radius: 10px;
      font-weight: 600;
      font-size: 14px;
      text-decoration: none;
      margin-top: 12px;
    }
    .badge-success {
      display: inline-block;
      padding: 4px 10px;
      background-color: #e8f4ec;
      color: #1d623c;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
    }
    .badge-warning {
      display: inline-block;
      padding: 4px 10px;
      background-color: #fce8c5;
      color: #87510f;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <a href="${escapeHtml(brand.publicAppUrl)}" class="brand">Uttily<span>.</span></a>
      </div>
      <div class="body">
        ${options.contentHtml}
      </div>
      <div class="footer">
        Uttily — Plateforme de location d'équipements professionnels.<br>
        Pour toute assistance, contactez votre loueur ou <a href="mailto:${escapeHtml(brand.supportEmail)}">${escapeHtml(brand.supportEmail)}</a>.
      </div>
    </div>
  </div>
</body>
</html>`;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function formatEur(minor: number): string {
  return `${(minor / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

export function formatDate(date: Date, timeZone = 'Europe/Paris'): string {
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone,
  }).format(date);
}
