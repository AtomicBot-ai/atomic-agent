import { describe, expect, it } from "vitest";

import { createTracingDefaults } from "../../config/tracing-config.js";
import {
  parseOtelKeyValueList,
  resolveOtlpExportSettings,
  type OtelExportConfig,
} from "./otlp-config.js";

const defaults = (): OtelExportConfig => createTracingDefaults().otel;
const withConfig = (patch: Partial<OtelExportConfig>): OtelExportConfig => ({
  ...defaults(),
  ...patch,
});

describe("parseOtelKeyValueList", () => {
  it("parses the OTEL_EXPORTER_OTLP_HEADERS format", () => {
    expect(parseOtelKeyValueList("api-key=abc123,x-team = core ")).toEqual({
      "api-key": "abc123",
      "x-team": "core",
    });
  });

  it("percent-decodes keys and values and keeps '=' inside a value", () => {
    expect(
      parseOtelKeyValueList("Authorization=Basic%20cGs6c2s%3D,x=a=b"),
    ).toEqual({ Authorization: "Basic cGs6c2s=", x: "a=b" });
  });

  it("skips entries without a key or without '=' instead of failing", () => {
    expect(parseOtelKeyValueList("novalue,=orphan,,ok=1")).toEqual({ ok: "1" });
    expect(parseOtelKeyValueList(undefined)).toEqual({});
    expect(parseOtelKeyValueList("")).toEqual({});
  });

  it("keeps a value that is not valid percent-encoding as written", () => {
    expect(parseOtelKeyValueList("k=100%")).toEqual({ k: "100%" });
  });
});

describe("resolveOtlpExportSettings", () => {
  it("is off by default: no config endpoint, no OTEL env", () => {
    expect(resolveOtlpExportSettings(defaults(), {})).toEqual({ kind: "off" });
    expect(resolveOtlpExportSettings(undefined, {})).toEqual({ kind: "off" });
  });

  it("turns on from the config endpoint and appends /v1/traces", () => {
    const result = resolveOtlpExportSettings(
      withConfig({ endpoint: "http://localhost:4318/" }),
      {},
    );
    expect(result.kind).toBe("on");
    if (result.kind !== "on") return;
    expect(result.settings.tracesUrl).toBe("http://localhost:4318/v1/traces");
    expect(result.settings.captureContent).toBe(false);
    expect(result.settings.serviceName).toBe("atomic-agent");
  });

  it("does not append /v1/traces twice", () => {
    const result = resolveOtlpExportSettings(
      withConfig({ endpoint: "https://collector.example/v1/traces" }),
      {},
    );
    expect(result.kind === "on" && result.settings.tracesUrl).toBe(
      "https://collector.example/v1/traces",
    );
  });

  it("prefers the traces env var (as given) over the base var and the config", () => {
    const result = resolveOtlpExportSettings(
      withConfig({ endpoint: "http://from-config:4318" }),
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://from-base:4318",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://from-traces:4318/custom",
      },
    );
    expect(result.kind === "on" && result.settings.tracesUrl).toBe(
      "http://from-traces:4318/custom",
    );
    const base = resolveOtlpExportSettings(
      withConfig({ endpoint: "http://from-config:4318" }),
      { OTEL_EXPORTER_OTLP_ENDPOINT: "http://from-base:4318" },
    );
    expect(base.kind === "on" && base.settings.tracesUrl).toBe(
      "http://from-base:4318/v1/traces",
    );
  });

  it("turns on from the environment alone", () => {
    const result = resolveOtlpExportSettings(defaults(), {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
    });
    expect(result.kind).toBe("on");
  });

  it("stays off when the config says enabled: false, whatever the env says", () => {
    expect(
      resolveOtlpExportSettings(withConfig({ enabled: false, endpoint: "http://x:4318" }), {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
      }),
    ).toEqual({ kind: "off" });
  });

  it("honours OTEL_SDK_DISABLED and OTEL_TRACES_EXPORTER=none", () => {
    const config = withConfig({ endpoint: "http://localhost:4318" });
    expect(resolveOtlpExportSettings(config, { OTEL_SDK_DISABLED: "true" }).kind).toBe("off");
    expect(resolveOtlpExportSettings(config, { OTEL_TRACES_EXPORTER: "none" }).kind).toBe("off");
  });

  it("reports enabled: true without an endpoint as invalid", () => {
    expect(resolveOtlpExportSettings(withConfig({ enabled: true }), {}).kind).toBe("invalid");
  });

  it("reports a non-http endpoint as invalid", () => {
    expect(
      resolveOtlpExportSettings(withConfig({ endpoint: "grpc://localhost:4317" }), {}).kind,
    ).toBe("invalid");
    expect(
      resolveOtlpExportSettings(withConfig({ endpoint: "not a url" }), {}).kind,
    ).toBe("invalid");
  });

  it("merges headers: config, then the general env var, then the traces one", () => {
    const result = resolveOtlpExportSettings(
      withConfig({
        endpoint: "http://localhost:4318",
        headers: { a: "config", b: "config", c: "config" },
      }),
      {
        OTEL_EXPORTER_OTLP_HEADERS: "b=env,c=env",
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: "c=traces",
      },
    );
    expect(result.kind === "on" && result.settings.headers).toEqual({
      a: "config",
      b: "env",
      c: "traces",
    });
  });

  it("reads the service name and resource attributes from the env", () => {
    const result = resolveOtlpExportSettings(withConfig({ endpoint: "http://h:4318" }), {
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=dev,service.name=from-resource",
    });
    expect(result.kind === "on" && result.settings.serviceName).toBe("from-resource");
    const named = resolveOtlpExportSettings(withConfig({ endpoint: "http://h:4318" }), {
      OTEL_SERVICE_NAME: "my-agent",
      OTEL_RESOURCE_ATTRIBUTES: "service.name=from-resource",
    });
    expect(named.kind === "on" && named.settings.serviceName).toBe("my-agent");
    expect(named.kind === "on" && named.settings.resourceAttributes).toEqual({
      "service.name": "from-resource",
    });
  });

  it("passes captureContent through only when the config sets it", () => {
    const result = resolveOtlpExportSettings(
      withConfig({ endpoint: "http://h:4318", captureContent: true }),
      {},
    );
    expect(result.kind === "on" && result.settings.captureContent).toBe(true);
  });
});
