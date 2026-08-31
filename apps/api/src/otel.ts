import { trace } from '@opentelemetry/api';

// Shared tracer used by all manual instrumentation points.
// Import this instead of calling trace.getTracer() in every service.
export const tracer = trace.getTracer('evpulse-api', '1.0.0');
