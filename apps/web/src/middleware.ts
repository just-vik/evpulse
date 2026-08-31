import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login', '/register', '/privacy'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow static files, API routes, root redirect, and well-known (Tesla key verification)
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api') ||
    pathname.startsWith('/.well-known') ||
    pathname.startsWith('/icons') ||
    pathname === '/manifest.json' ||
    pathname === '/favicon.ico' ||
    pathname === '/favicon.svg' ||
    pathname === '/'
  ) {
    return NextResponse.next();
  }

  const token = request.cookies.get('access_token')?.value;

  // On auth pages — redirect to dashboard if already logged in
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    if (token) {
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }
    return NextResponse.next();
  }

  // Protected routes — require token
  if (!token) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
};
