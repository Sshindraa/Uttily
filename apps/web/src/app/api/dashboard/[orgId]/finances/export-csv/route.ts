import { NextResponse } from 'next/server';
import { getMerchantFinanceOverview, exportFinancesCsv } from '@uttily/core';
import { requireFinancialViewerOf } from '@/lib/finances-auth';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  try {
    const { orgId } = await params;
    const { db, organizationId } = await requireFinancialViewerOf(orgId);

    const overview = await getMerchantFinanceOverview(db, organizationId);
    const csvContent = exportFinancesCsv(overview);

    const filename = `uttily-finances-${overview.period.label.toLowerCase().replace(/\s+/g, '-')}.csv`;

    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
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
