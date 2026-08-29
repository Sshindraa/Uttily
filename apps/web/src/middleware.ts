import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
  '/',
  '/fr/search(.*)',
  '/en/search(.*)',
  '/fr/offers(.*)',
  '/en/offers(.*)',
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
});

export const config = {
  matcher: ['/((?!.*\\..*|_next).*)', '/', '/(api|trpc)(.*)'],
};
