import { escapeHtml, renderEmailLayout } from './layout';
import type { RenderedEmail } from '../types';

export interface OrganizationInvitationData {
  organizationName: string;
  roleName: string;
  acceptUrl: string;
  expiresInDays?: number;
}

export function renderOrganizationInvitation(data: OrganizationInvitationData): RenderedEmail {
  const subject = `Invitation à rejoindre ${data.organizationName} sur Uttily`;
  const days = data.expiresInDays ?? 7;

  const contentHtml = `
    <h1>🤝 Invitation à rejoindre l’équipe</h1>
    <p>Bonjour,</p>
    <p>Vous avez été invité(e) à rejoindre l’organisation <strong>${escapeHtml(data.organizationName)}</strong> sur Uttily.</p>
    
    <div class="card">
      <div class="metric-row">
        <span class="metric-label">Organisation :</span>
        <span class="metric-value">${escapeHtml(data.organizationName)}</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Rôle attribué :</span>
        <span class="metric-value">${escapeHtml(data.roleName)}</span>
      </div>
    </div>

    <div style="text-align: center; margin: 2rem 0;">
      <a href="${escapeHtml(data.acceptUrl)}" style="background-color: #465b5f; color: #ffffff; padding: 0.75rem 1.5rem; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
        Rejoindre l’équipe
      </a>
    </div>

    <p style="font-size: 0.85rem; color: #546d72;">
      Cette invitation est valable ${days} jours. Si vous n’attendiez pas cette invitation, vous pouvez ignorer cet email.
    </p>
  `;

  const text = `Invitation à rejoindre l’équipe Uttily 🤝

Bonjour,

Vous avez été invité(e) à rejoindre l’organisation ${data.organizationName} sur Uttily.

Organisation : ${data.organizationName}
Rôle attribué : ${data.roleName}

Pour accepter l'invitation et rejoindre l'équipe, cliquez sur le lien ci-dessous :
${data.acceptUrl}

Cette invitation est valable ${days} jours.

L'équipe Uttily
`;

  return {
    subject,
    html: renderEmailLayout({ title: subject, contentHtml }),
    text,
  };
}
