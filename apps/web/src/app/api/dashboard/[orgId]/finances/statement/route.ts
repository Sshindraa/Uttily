import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { organizations } from '@uttily/database';
import { getMerchantFinanceOverview, generateCommissionStatementCsv } from '@uttily/core';
import { requireFinancialViewerOf } from '@/lib/finances-auth';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  try {
    const { orgId } = await params;
    const { db, organizationId } = await requireFinancialViewerOf(orgId);

    const [orgRows, overview] = await Promise.all([
      db
        .select({
          legalName: organizations.legalName,
          legalForm: organizations.legalForm,
          registrationNumber: organizations.registrationNumber,
          vatNumber: organizations.vatNumber,
          registryCity: organizations.registryCity,
          registeredOfficeAddress: organizations.registeredOfficeAddress,
          registeredOfficePostalCode: organizations.registeredOfficePostalCode,
          registeredOfficeCity: organizations.registeredOfficeCity,
        })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1),
      getMerchantFinanceOverview(db, organizationId),
    ]);

    const org = orgRows[0] ?? { legalName: 'Partenaire' };
    const csvContent = generateCommissionStatementCsv({
      organization: org,
      overview,
    });

    const filename = `decompte-commissions-uttily-${overview.period.label.toLowerCase().replace(/\s+/g, '-')}.csv`;

    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, no-cache, no-store, must-revalidate',
      },
    });
  } catch (error) {
    const isAuthError =
      error instanceof Error &&
      (error.message === 'UNAUTHENTICATED' || error.message === 'FORBIDDEN');
    return new NextResponse(
      JSON.stringify({ error: isAuthError ? error.message : 'UNAUTHORIZED' }),
      {
        status: isAuthError && error.message === 'FORBIDDEN' ? 403 : 401,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
}
