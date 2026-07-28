import { NodeSDK } from "@opentelemetry/sdk-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PostHogSpanProcessor } from "@posthog/ai/otel";
import { OpenAIInstrumentation } from "@opentelemetry/instrumentation-openai";
import { GenAIInstrumentation } from "@traceloop/instrumentation-google-generativeai";

export async function register() {

  const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;

  if (!token) {
    if (process.env.NODE_ENV !== "production") {
      throw new Error(
        "NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN is configured"
      );
    }
    return;
  }

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      "service.name": "pickem-labs",
    }),
    spanProcessors: [
      new PostHogSpanProcessor({
        projectToken: token,
        host: host ?? "https://us.i.posthog.com",
      }),
    ],
    instrumentations: [
      new OpenAIInstrumentation(),
      new GenAIInstrumentation(),
    ],
  });

  sdk.start();
}
