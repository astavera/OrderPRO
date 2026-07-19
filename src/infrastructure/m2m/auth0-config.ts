import "server-only";

const REQUIRED_AUTH0_VARIABLES = [
  "ORDERPRO_RUNTIME_ENVIRONMENT",
  "ORDERPRO_M2M_ISSUER",
  "ORDERPRO_M2M_AUDIENCE",
  "ORDERPRO_M2M_JWKS_URI",
  "ORDERPRO_M2M_ALLOWED_ALGORITHM",
] as const;

export const ORDERPRO_STAGING_M2M_AUDIENCE =
  "https://api.orderpro.internal/local-delivery/staging";

export const AUTH0_M2M_ENVIRONMENT_VARIABLES = [
  "ORDERPRO_M2M_AUTH_MODE",
  ...REQUIRED_AUTH0_VARIABLES,
] as const;

type Auth0M2mEnvironmentVariable = (typeof AUTH0_M2M_ENVIRONMENT_VARIABLES)[number];
type RequiredAuth0Variable = (typeof REQUIRED_AUTH0_VARIABLES)[number];

export type Auth0M2mConfiguration = {
  mode: "AUTH0";
  environment: "STAGING";
  issuer: string;
  audience: string;
  jwksUri: string;
  allowedAlgorithm: "RS256";
  tokenProfile: "RFC9068";
};

export type Auth0M2mConfigurationResult =
  | { valid: false; state: "DISABLED" }
  | {
      valid: false;
      state: "INCOMPLETE";
      missingVariables: RequiredAuth0Variable[];
    }
  | {
      valid: false;
      state: "INVALID" | "ENVIRONMENT_MISMATCH";
      invalidVariables: Auth0M2mEnvironmentVariable[];
    }
  | { valid: true; config: Auth0M2mConfiguration };

function isCanonicalAuth0Issuer(value: string) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.hostname.endsWith(".auth0.com") &&
      url.hostname.split(".").length >= 3 &&
      url.href === value
    );
  } catch {
    return false;
  }
}

function isCanonicalHttpsAudience(value: string) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.pathname !== "/" &&
      url.search === "" &&
      url.hash === "" &&
      !url.hostname.endsWith(".auth0.com") &&
      url.href === value
    );
  } catch {
    return false;
  }
}

export function parseAuth0M2mConfiguration(
  environment: Record<string, string | undefined>,
): Auth0M2mConfigurationResult {
  const mode = environment.ORDERPRO_M2M_AUTH_MODE?.trim();

  if (!mode || mode === "DISABLED") {
    return { valid: false, state: "DISABLED" };
  }

  if (mode !== "AUTH0") {
    return {
      valid: false,
      state: "INVALID",
      invalidVariables: ["ORDERPRO_M2M_AUTH_MODE"],
    };
  }

  const values = Object.fromEntries(
    REQUIRED_AUTH0_VARIABLES.map((variable) => [variable, environment[variable]?.trim() ?? ""]),
  ) as Record<RequiredAuth0Variable, string>;
  const missingVariables = REQUIRED_AUTH0_VARIABLES.filter((variable) => !values[variable]);

  if (missingVariables.length > 0) {
    return { valid: false, state: "INCOMPLETE", missingVariables };
  }

  if (values.ORDERPRO_RUNTIME_ENVIRONMENT !== "STAGING") {
    return {
      valid: false,
      state: "ENVIRONMENT_MISMATCH",
      invalidVariables: ["ORDERPRO_RUNTIME_ENVIRONMENT"],
    };
  }

  const invalidVariables: Auth0M2mEnvironmentVariable[] = [];
  if (!isCanonicalAuth0Issuer(values.ORDERPRO_M2M_ISSUER)) {
    invalidVariables.push("ORDERPRO_M2M_ISSUER");
  }
  if (
    !isCanonicalHttpsAudience(values.ORDERPRO_M2M_AUDIENCE) ||
    values.ORDERPRO_M2M_AUDIENCE !== ORDERPRO_STAGING_M2M_AUDIENCE
  ) {
    invalidVariables.push("ORDERPRO_M2M_AUDIENCE");
  }
  if (
    values.ORDERPRO_M2M_JWKS_URI !==
    `${values.ORDERPRO_M2M_ISSUER}.well-known/jwks.json`
  ) {
    invalidVariables.push("ORDERPRO_M2M_JWKS_URI");
  }
  if (values.ORDERPRO_M2M_ALLOWED_ALGORITHM !== "RS256") {
    invalidVariables.push("ORDERPRO_M2M_ALLOWED_ALGORITHM");
  }

  if (invalidVariables.length > 0) {
    return { valid: false, state: "INVALID", invalidVariables };
  }

  return {
    valid: true,
    config: {
      mode: "AUTH0",
      environment: "STAGING",
      issuer: values.ORDERPRO_M2M_ISSUER,
      audience: values.ORDERPRO_M2M_AUDIENCE,
      jwksUri: values.ORDERPRO_M2M_JWKS_URI,
      allowedAlgorithm: "RS256",
      tokenProfile: "RFC9068",
    },
  };
}

export function getAuth0M2mConfiguration() {
  return parseAuth0M2mConfiguration(process.env);
}
