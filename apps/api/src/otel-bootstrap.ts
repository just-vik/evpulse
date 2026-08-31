import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { NodeSDK, resources } from '@opentelemetry/sdk-node';
import {
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_NAMESPACE,
  SEMRESATTRS_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import * as os from 'os';

// Explicit opt-in: OTEL_ENABLED=true required.
// Default (env var absent or set to anything else) → silent no-op.
if (process.env.OTEL_ENABLED === 'true') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

  const serviceName = process.env.OTEL_SERVICE_NAME            ?? 'evpulse-api';
  const endpoint    = process.env.OTEL_EXPORTER_OTLP_ENDPOINT  ?? 'http://tempo:4318';

  const sdk = new NodeSDK({
    resource: resources.resourceFromAttributes({
      [SEMRESATTRS_SERVICE_NAME]:      serviceName,
      [SEMRESATTRS_SERVICE_NAMESPACE]: 'evpulse',
      [SEMRESATTRS_SERVICE_VERSION]:   process.env.npm_package_version ?? '1.0.0',
      'service.instance.id':           `${os.hostname()}-${process.pid}`,
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs':  { enabled: false }, // too noisy
        '@opentelemetry/instrumentation-dns': { enabled: false }, // too noisy
      }),
    ],
  });

  try {
    sdk.start();
    console.log('[OTel] Tracing initialized →', endpoint);
  } catch (err) {
    console.error('[OTel] Error initializing tracing', err);
  }

  const shutdown = () => {
    sdk.shutdown()
      .then(() => { console.log('[OTel] Tracing terminated'); process.exit(0); })
      .catch((err) => { console.error('[OTel] Error terminating tracing', err); process.exit(1); });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);
}
