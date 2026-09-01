import { redirect } from 'next/navigation';
import { requireSupportPlatformAdmin } from '@/lib/support-auth';
import { SupportShell } from '@/components/shells/support-shell';

export default async function InternalLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactElement> {
  let adminContext;
  try {
    adminContext = await requireSupportPlatformAdmin();
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'UNAUTHENTICATED') {
      redirect('/sign-in');
    }
    // Fail-closed pour les utilisateurs non-admin Uttily
    return <SupportShell accessDenied />;
  }

  const { user } = adminContext;

  return <SupportShell userEmail={user.email}>{children}</SupportShell>;
}
