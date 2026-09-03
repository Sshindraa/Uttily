import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function GET(request: NextRequest): NextResponse {
  return NextResponse.redirect(new URL('/fr/terms', request.url), 308);
}
