import { NextRequest, NextResponse } from 'next/server';

/**
 * Server-side logout handler.
 *
 * The backend sets access_token as an HttpOnly cookie — JavaScript in the
 * browser cannot clear it. This route calls the NestJS backend (which always
 * clears the cookie regardless of token validity), then forwards the
 * backend's Set-Cookie header to the browser so the httpOnly cookie is
 * removed with the correct Domain attribute.
 */
export async function POST(request: NextRequest) {
  const token = request.cookies.get('access_token')?.value;

  const dest = process.env.INTERNAL_API_URL ?? 'http://evpulse-api:3000';

  let backendSetCookies: string[] = [];

  try {
    const backendRes = await fetch(`${dest}/api/v1/auth/logout`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    // Collect all Set-Cookie headers the backend sent (correct domain, httpOnly, etc.)
    const raw = backendRes.headers.get('set-cookie');
    if (raw) backendSetCookies = [raw];
  } catch {
    // ignore — we still clear below
  }

  const response = NextResponse.json({ success: true });

  // Forward backend's Set-Cookie (carries the exact Domain/Path used when setting)
  for (const sc of backendSetCookies) {
    response.headers.append('Set-Cookie', sc);
  }

  // Fallback: clear for the domain configured in env (covers both dot and no-dot variants)
  const domain = process.env.COOKIE_DOMAIN ?? 'evpulse.app';
  const base = `access_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`;
  response.headers.append('Set-Cookie', `${base}; Domain=${domain}; HttpOnly`);
  response.headers.append('Set-Cookie', `${base}; Domain=${domain}`);
  response.headers.append('Set-Cookie', base); // no-domain fallback

  return response;
}
