import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Privacy Policy — EVPulse',
  description: 'How EVPulse collects, uses, and protects your data.',
};

const EFFECTIVE_DATE = 'April 9, 2026';
const CONTACT_EMAIL = 'privacy@evpulse.app';
const APP_URL = 'https://evpulse.app';

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-[hsl(220_14%_7%)] text-[hsl(215_14%_85%)]">
      <div className="max-w-2xl mx-auto px-6 py-16">

        {/* Header */}
        <div className="mb-12">
          <Link href="/" className="text-[hsl(215_14%_50%)] text-sm hover:text-[hsl(215_14%_75%)] transition-colors">
            ← EVPulse
          </Link>
          <h1 className="mt-6 text-3xl font-bold text-white">Privacy Policy</h1>
          <p className="mt-2 text-sm text-[hsl(215_14%_50%)]">Effective date: {EFFECTIVE_DATE}</p>
        </div>

        <div className="prose prose-invert prose-sm max-w-none space-y-10">

          <Section title="1. Who we are">
            <p>
              EVPulse (&ldquo;we&rdquo;, &ldquo;our&rdquo;, &ldquo;us&rdquo;) is an independent third-party
              analytics service for Tesla owners. We are not affiliated with Tesla, Inc.
              Our service is accessible at <a href={APP_URL} className="text-blue-400 hover:underline">{APP_URL}</a>.
            </p>
            <p>Contact: <a href={`mailto:${CONTACT_EMAIL}`} className="text-blue-400 hover:underline">{CONTACT_EMAIL}</a></p>
          </Section>

          <Section title="2. What data we collect">
            <p>We collect only the data required to provide the service:</p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong>Account data</strong> — email address and hashed password (bcrypt), created when you register.</li>
              <li><strong>Tesla OAuth tokens</strong> — access and refresh tokens issued by Tesla after you authorise EVPulse in the Tesla app. Tokens are encrypted at rest using AES-256-GCM and never shared with third parties.</li>
              <li><strong>Telemetry data</strong> — GPS coordinates, speed, battery level (SoC), power draw, odometer, and shift state streamed from your vehicle via Tesla Fleet Telemetry or the Tesla REST API. This data is stored in our database and used exclusively to generate your trip, charging, and battery analytics.</li>
              <li><strong>Usage data</strong> — standard server logs (IP address, user-agent, request path, timestamp) retained for up to 30 days for security and debugging purposes.</li>
            </ul>
            <p>We do <strong>not</strong> collect payment card numbers (handled by Stripe), sell data to third parties, or use telemetry data for advertising.</p>
          </Section>

          <Section title="3. How we use your data">
            <ul className="list-disc pl-5 space-y-1.5">
              <li>Display your trip history, charging sessions, and battery health analytics within the app.</li>
              <li>Generate AI-powered insights using your aggregated (anonymised) trip and efficiency data.</li>
              <li>Send transactional emails — account confirmation, password reset, billing receipts. No marketing emails without explicit opt-in.</li>
              <li>Detect and prevent abuse of our platform.</li>
            </ul>
          </Section>

          <Section title="4. Legal basis (GDPR)">
            <p>For users in the European Economic Area, the United Kingdom, and Switzerland, our legal bases are:</p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong>Contract performance</strong> (Art. 6(1)(b) GDPR) — processing your vehicle telemetry to deliver the analytics service you signed up for.</li>
              <li><strong>Legitimate interests</strong> (Art. 6(1)(f) GDPR) — security logging and fraud prevention.</li>
              <li><strong>Consent</strong> (Art. 6(1)(a) GDPR) — optional features such as push notifications and AI insights, which you can withdraw at any time in Settings.</li>
            </ul>
          </Section>

          <Section title="5. Data retention">
            <ul className="list-disc pl-5 space-y-1.5">
              <li>Telemetry and trip data: retained while your account is active. Deleted within 30 days of account deletion.</li>
              <li>Tesla OAuth tokens: deleted immediately when you disconnect your vehicle or delete your account.</li>
              <li>Billing records: retained for 7 years as required by applicable tax law.</li>
              <li>Server logs: 30 days.</li>
            </ul>
          </Section>

          <Section title="6. Third-party services">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-[hsl(215_20%_20%)]">
                  <th className="text-left py-2 pr-4 text-[hsl(215_14%_65%)] font-medium">Service</th>
                  <th className="text-left py-2 pr-4 text-[hsl(215_14%_65%)] font-medium">Purpose</th>
                  <th className="text-left py-2 text-[hsl(215_14%_65%)] font-medium">Privacy</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[hsl(215_20%_14%)]">
                <tr>
                  <td className="py-2 pr-4 text-white">Tesla, Inc.</td>
                  <td className="py-2 pr-4">Vehicle data access via Fleet API</td>
                  <td className="py-2"><a href="https://www.tesla.com/legal/privacy" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">tesla.com/legal/privacy</a></td>
                </tr>
                <tr>
                  <td className="py-2 pr-4 text-white">Stripe</td>
                  <td className="py-2 pr-4">Payment processing</td>
                  <td className="py-2"><a href="https://stripe.com/privacy" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">stripe.com/privacy</a></td>
                </tr>
                <tr>
                  <td className="py-2 pr-4 text-white">Resend</td>
                  <td className="py-2 pr-4">Transactional email delivery</td>
                  <td className="py-2"><a href="https://resend.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">resend.com/legal/privacy-policy</a></td>
                </tr>
                <tr>
                  <td className="py-2 pr-4 text-white">Anthropic</td>
                  <td className="py-2 pr-4">AI-generated driving insights (optional)</td>
                  <td className="py-2"><a href="https://www.anthropic.com/privacy" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">anthropic.com/privacy</a></td>
                </tr>
                <tr>
                  <td className="py-2 pr-4 text-white">Nominatim / OpenStreetMap</td>
                  <td className="py-2 pr-4">Reverse-geocoding trip start/end addresses</td>
                  <td className="py-2"><a href="https://osmfoundation.org/wiki/Privacy_Policy" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">osmfoundation.org/…/Privacy_Policy</a></td>
                </tr>
              </tbody>
            </table>
            <p className="mt-3 text-[hsl(215_14%_50%)] text-xs">
              GPS coordinates sent to Nominatim are used solely for address lookup and are subject to OSM&apos;s
              Nominatim usage policy (max 1 req/s, no bulk geocoding).
            </p>
          </Section>

          <Section title="7. Your rights">
            <p>Depending on your jurisdiction you may have the right to:</p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong>Access</strong> — request a copy of all personal data we hold about you.</li>
              <li><strong>Rectification</strong> — correct inaccurate data.</li>
              <li><strong>Erasure</strong> — delete your account and all associated data (Settings → Delete account, or email us).</li>
              <li><strong>Portability</strong> — export your trip and telemetry data as JSON (Settings → Export data).</li>
              <li><strong>Withdraw consent</strong> — disconnect your Tesla vehicle or disable AI insights at any time in Settings.</li>
              <li><strong>Lodge a complaint</strong> — with the supervisory authority in your country (e.g. BfDI in Germany, ICO in the UK).</li>
            </ul>
            <p>To exercise any right, email <a href={`mailto:${CONTACT_EMAIL}`} className="text-blue-400 hover:underline">{CONTACT_EMAIL}</a>. We respond within 30 days.</p>
          </Section>

          <Section title="8. Data security">
            <p>
              Tesla tokens are encrypted with AES-256-GCM before storage. Our servers run behind TLS 1.3.
              Database access is restricted to backend services within a private Docker network.
              We conduct regular security reviews and apply dependency updates promptly.
            </p>
            <p>
              In the event of a data breach affecting your personal data we will notify you and the
              relevant supervisory authority within 72 hours as required by GDPR Art. 33–34.
            </p>
          </Section>

          <Section title="9. Children">
            <p>
              EVPulse is not directed at children under 16. We do not knowingly collect data from minors.
              If you believe a minor has registered, contact us and we will delete the account promptly.
            </p>
          </Section>

          <Section title="10. Changes to this policy">
            <p>
              We may update this policy when we add new features or if legal requirements change.
              We will notify registered users by email at least 14 days before material changes take effect.
              The effective date at the top of this page always reflects the latest version.
            </p>
          </Section>

        </div>

        {/* Footer */}
        <div className="mt-16 pt-8 border-t border-[hsl(215_20%_15%)] text-center text-xs text-[hsl(215_14%_40%)]">
          <p>EVPulse · <a href={`mailto:${CONTACT_EMAIL}`} className="hover:text-[hsl(215_14%_60%)] transition-colors">{CONTACT_EMAIL}</a></p>
          <p className="mt-1">© {new Date().getFullYear()} EVPulse. All rights reserved.</p>
        </div>

      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-3">{title}</h2>
      <div className="space-y-3 text-[hsl(215_14%_72%)] leading-relaxed text-sm">{children}</div>
    </section>
  );
}
