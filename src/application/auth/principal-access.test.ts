import { describe, expect, it } from "vitest";
import { activeLocationIds, getAccountAccessStatus, hasProvisionedAccess } from "./principal-access";

describe("principal provisioning", () => {
  const ready = {
    active: true,
    roles: [{ role: "OWNER" }],
    locations: [{ locationId: "active", location: { active: true } }],
  };

  it("requires an active account, a role and an active location", () => {
    expect(hasProvisionedAccess(ready)).toBe(true);
    expect(hasProvisionedAccess({ ...ready, active: false })).toBe(false);
    expect(hasProvisionedAccess({ ...ready, roles: [] })).toBe(false);
    expect(hasProvisionedAccess({ ...ready, locations: [] })).toBe(false);
    expect(hasProvisionedAccess({ ...ready, locations: [{ location: { active: false } }] })).toBe(false);
  });

  it("distinguishes disabled accounts from pending provisioning", () => {
    expect(getAccountAccessStatus({ ...ready, active: false })).toBe("DISABLED");
    expect(getAccountAccessStatus({ ...ready, roles: [] })).toBe("PENDING");
    expect(getAccountAccessStatus(ready)).toBe("ACTIVE");
  });

  it("returns only active location grants", () => {
    expect(
      activeLocationIds({
        locations: [
          ...ready.locations,
          { locationId: "inactive", location: { active: false } },
        ],
      }),
    ).toEqual(["active"]);
  });
});
