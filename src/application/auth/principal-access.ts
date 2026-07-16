export type ProvisionedAccountCandidate = {
  active: boolean;
  roles: readonly unknown[];
  locations: readonly { location: { active: boolean } }[];
};

export type AccountAccessStatus = "ACTIVE" | "PENDING" | "DISABLED";

export function getAccountAccessStatus(account: ProvisionedAccountCandidate | null | undefined): AccountAccessStatus {
  if (account && !account.active) return "DISABLED";
  if (
    account?.active &&
    account.roles.length > 0 &&
    account.locations.some(({ location }) => location.active)
  ) {
    return "ACTIVE";
  }
  return "PENDING";
}

export function hasProvisionedAccess(account: ProvisionedAccountCandidate | null | undefined) {
  return getAccountAccessStatus(account) === "ACTIVE";
}

export function activeLocationIds<T extends { locationId: string; location: { active: boolean } }>(account: {
  locations: readonly T[];
}) {
  return account.locations.filter(({ location }) => location.active).map(({ locationId }) => locationId);
}
