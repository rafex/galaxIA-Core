/**
 * Valida los campos obligatorios del manifiesto (DEC-0013,
 * `docs/protocolo-provider.md`, sección "Manifiesto — campos obligatorios
 * sin excepción"). Un manifiesto sin `privacy.retention` debe rechazarse,
 * no aceptarse con un valor por defecto silencioso.
 */
export interface ManifestValidationResult {
  valid: boolean;
  missing: string[];
}

interface ManifestShape {
  fhsVersion?: unknown;
  provider?: { id?: unknown; type?: unknown; visibility?: unknown };
  privacy?: { retention?: unknown; trainingUse?: unknown };
  services?: Array<{ endpoint?: unknown }>;
  endpoint?: unknown;
}

function isManifestShape(value: unknown): value is ManifestShape {
  return typeof value === "object" && value !== null;
}

export function validateManifest(input: unknown): ManifestValidationResult {
  const missing: string[] = [];

  if (!isManifestShape(input)) {
    return { valid: false, missing: ["manifest"] };
  }
  const manifest = input;
  if (!manifest.fhsVersion) missing.push("fhsVersion");
  if (!manifest.provider?.id) missing.push("provider.id");
  if (!manifest.provider?.type) missing.push("provider.type");
  if (!manifest.provider?.visibility) missing.push("provider.visibility");
  if (!manifest.privacy?.retention) missing.push("privacy.retention");
  if (manifest.provider?.type === "llm" && manifest.privacy?.trainingUse === undefined) {
    missing.push("privacy.trainingUse");
  }

  if (manifest.provider?.type === "multi") {
    if (!Array.isArray(manifest.services) || manifest.services.length === 0) {
      missing.push("services");
    } else {
      manifest.services.forEach((service, i) => {
        if (!service.endpoint) missing.push(`services[${i}].endpoint`);
      });
    }
  } else if (!manifest.endpoint) {
    missing.push("endpoint");
  }

  return { valid: missing.length === 0, missing };
}
