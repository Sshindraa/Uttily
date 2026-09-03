import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const isPublicRoute = createRouteMatcher([
  '/',
  '/fr/search(.*)',
  '/en/search(.*)',
  '/fr/offers(.*)',
  '/en/offers(.*)',
  '/fr/terms(.*)',
  '/en/terms(.*)',
  '/fr/rental-terms(.*)',
  '/en/rental-terms(.*)',
  '/fr/privacy(.*)',
  '/en/privacy(.*)',
  '/fr/legal(.*)',
  '/en/legal(.*)',
  '/cgu(.*)',
  '/cgv(.*)',
  '/politique-de-confidentialite(.*)',
  '/mentions-legales(.*)',
  '/terms(.*)',
  '/privacy(.*)',
  '/legal(.*)',
  '/api/public/search(.*)',
  // Les webhooks sont authentifiés par la signature Stripe dans leur route.
  // Ils doivent rester accessibles sans session Clerk pour que Stripe puisse
  // les livrer à l'application.
  '/api/webhooks/stripe(.*)',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/photo-coach-demo(.*)',
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }

  const pathname = req.nextUrl.pathname;
  if (pathname === '/cgu' || pathname === '/terms') {
    const url = req.nextUrl.clone();
    url.pathname = '/fr/terms';
    return NextResponse.redirect(url, 308);
  }
  if (pathname === '/cgv' || pathname === '/rental-terms') {
    const url = req.nextUrl.clone();
    url.pathname = '/fr/rental-terms';
    return NextResponse.redirect(url, 308);
  }
  if (pathname === '/politique-de-confidentialite' || pathname === '/privacy') {
    const url = req.nextUrl.clone();
    url.pathname = '/fr/privacy';
    return NextResponse.redirect(url, 308);
  }
  if (pathname === '/mentions-legales' || pathname === '/legal') {
    const url = req.nextUrl.clone();
    url.pathname = '/fr/legal';
    return NextResponse.redirect(url, 308);
  }

  if (/^\/dashboard\/[^/]+\/operations$/.test(pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = url.pathname.replace(/\/operations$/, '/bookings');
    return NextResponse.redirect(url);
  }
});

export const config = {
  matcher: ['/((?!.*\\..*|_next).*)', '/', '/(api|trpc)(.*)'],
};
