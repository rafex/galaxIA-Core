import { describe, expect, it } from "vitest";
import {
  DiagnosticsLog,
  certAcceptUrl,
  describeError,
  errorText,
  hintForTarget,
} from "../src/services/diagnostics.js";

const NAVIGATOR = "/ip4/192.168.1.139/tcp/4010/tls/ws/p2p/12D3KooWJNDdrDDeJS15GyrEyqzuXzdZF5f1UXKTQGZEHPfrVdsi";
const ATLAS = "/ip4/192.168.1.139/tcp/4001/tls/ws";

function quietLog(): DiagnosticsLog {
  return new DiagnosticsLog(300, null);
}

describe("describeError", () => {
  it("names the WebSocket url instead of [object Event]", () => {
    const event = { type: "error", target: { url: "wss://192.168.1.139:4010" } };
    expect(describeError(event).message).toBe("No se pudo abrir la conexión wss://192.168.1.139:4010");
  });

  it("handles a real Event without a target", () => {
    expect(describeError(new Event("error")).message).toBe("No se pudo abrir la conexión");
  });

  it("describes an abnormal close", () => {
    const close = { type: "close", code: 1006, reason: "", target: { url: "wss://h:4001" } };
    const { message } = describeError(close);
    expect(message).toContain("código 1006");
    expect(message).toContain("cierre anormal");
  });

  it("flattens AggregateError keeping every inner reason", () => {
    const aggregate = new AggregateError(
      [{ type: "error", target: { url: "wss://a:4010" } }, new Error("ECONNREFUSED")],
      "All multiaddr dials failed",
    );
    const described = describeError(aggregate);
    expect(described.message).toBe("All multiaddr dials failed");
    expect(described.details).toEqual(["No se pudo abrir la conexión wss://a:4010", "ECONNREFUSED"]);
    expect(errorText(aggregate)).toContain("wss://a:4010");
  });

  it("keeps the error name and its cause", () => {
    const error = new TypeError("fallo externo", { cause: new Error("causa interna") });
    expect(describeError(error)).toEqual({ message: "TypeError: fallo externo", details: ["causa interna"] });
  });
});

describe("hints", () => {
  it("builds the https page to accept a certificate", () => {
    expect(certAcceptUrl(NAVIGATOR)).toBe("https://192.168.1.139:4010/");
    expect(certAcceptUrl("/ip6/::1/tcp/4010/tls/ws")).toBe("https://[::1]:4010/");
    expect(certAcceptUrl("/dns4/demo.rafex.io/tcp/443/tls/ws")).toBe("https://demo.rafex.io:443/");
  });

  it("marks advertised loopback addresses as expected when the page is remote", () => {
    expect(hintForTarget("/ip4/127.0.0.1/tcp/4010/tls/ws", "192.168.1.239")).toContain("loopback");
  });

  it("points to the certificate page for a remote address", () => {
    expect(hintForTarget(NAVIGATOR, "192.168.1.239")).toContain("https://192.168.1.139:4010/");
  });
});

describe("DiagnosticsLog.summary", () => {
  it("reports a failed bootstrap", () => {
    const log = quietLog();
    log.beginAttempt(0);
    log.record({ stage: "bootstrap", ok: false, message: "No se pudo abrir la conexión", target: ATLAS });
    expect(log.summary()).toBe(`Sin conexión con el bootstrap (Atlas): falló ${ATLAS}`);
  });

  it("reports a swarm without a Navigator advertise", () => {
    const log = quietLog();
    log.beginAttempt(0);
    log.record({ stage: "bootstrap", ok: true, message: "ok", target: ATLAS });
    expect(log.summary()).toContain("no llegó ningún anuncio de Navigator");
    log.record({ stage: "advertise", ok: true, kind: "other", message: "Anuncio de star" });
    expect(log.summary()).toContain("1 anuncios de otros nodos");
  });

  it("names the Navigator address that failed — the case that used to be silent", () => {
    const log = quietLog();
    log.beginAttempt(0);
    log.record({ stage: "bootstrap", ok: true, message: "ok", target: ATLAS });
    log.record({ stage: "advertise", ok: true, kind: "navigator", message: "ok" });
    log.record({ stage: "navigator-dial", ok: false, message: "No se pudo abrir la conexión", target: "/ip4/127.0.0.1/tcp/4010/tls/ws" });
    log.record({ stage: "navigator-dial", ok: false, message: "No se pudo abrir la conexión", target: NAVIGATOR });
    expect(log.summary()).toBe(`Navigator encontrado, pero falló la conexión a ${NAVIGATOR}`);
  });

  it("only looks at the current attempt", () => {
    const log = quietLog();
    log.beginAttempt(0);
    log.record({ stage: "bootstrap", ok: false, message: "falló", target: ATLAS });
    log.beginAttempt(1);
    expect(log.summary()).toBe("");
    expect(log.list().length).toBe(3);
  });
});

describe("DiagnosticsLog.endpoints", () => {
  it("keeps the latest state per transport address, ignoring the /p2p suffix", () => {
    const log = quietLog();
    log.beginAttempt(0);
    log.record({ stage: "navigator-dial", ok: false, message: "falló", target: NAVIGATOR });
    log.record({ stage: "navigator-dial", ok: true, message: "ok", target: NAVIGATOR.replace(/\/p2p\/.*/, "/p2p/12D3KooWOtro") });
    const endpoints = log.endpoints("192.168.1.239");
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].ok).toBe(true);
  });

  it("offers the certificate link for a failed remote endpoint", () => {
    const log = quietLog();
    log.beginAttempt(0);
    log.record({ stage: "navigator-dial", ok: false, message: "falló", target: NAVIGATOR });
    expect(log.endpoints("192.168.1.239")[0].acceptUrl).toBe("https://192.168.1.139:4010/");
  });

  it("includes every event in the shareable report", () => {
    const log = quietLog();
    log.beginAttempt(0);
    log.record({ stage: "navigator-dial", ok: false, message: "falló", target: NAVIGATOR, hint: "acepta el certificado" });
    const report = log.report({ version: "abc123" });
    expect(report).toContain("Versión: abc123");
    expect(report).toContain(NAVIGATOR);
    expect(report).toContain("acepta el certificado");
  });
});
