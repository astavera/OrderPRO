export const containerStatuses = [
  "OPEN", "MANIFEST_CLOSED", "SEALED", "STAGED", "IN_TRANSIT", "RECEIVED_PENDING_VERIFICATION",
  "RECEIVED", "PUTAWAY", "ACTIVE", "QUARANTINED", "DAMAGED", "LOST", "EMPTY", "ARCHIVED",
] as const;

export type ContainerStatus = (typeof containerStatuses)[number];

const allowedTransitions: Record<ContainerStatus, readonly ContainerStatus[]> = {
  OPEN: ["MANIFEST_CLOSED", "QUARANTINED", "EMPTY"],
  MANIFEST_CLOSED: ["OPEN", "SEALED", "QUARANTINED"],
  SEALED: ["STAGED", "OPEN", "QUARANTINED"],
  STAGED: ["IN_TRANSIT", "QUARANTINED"],
  IN_TRANSIT: ["RECEIVED_PENDING_VERIFICATION", "LOST", "DAMAGED", "QUARANTINED"],
  RECEIVED_PENDING_VERIFICATION: ["RECEIVED", "DAMAGED", "QUARANTINED"],
  RECEIVED: ["PUTAWAY", "QUARANTINED"],
  PUTAWAY: ["ACTIVE", "QUARANTINED"],
  ACTIVE: ["PUTAWAY", "EMPTY", "QUARANTINED"],
  QUARANTINED: ["OPEN", "RECEIVED", "DAMAGED", "LOST", "ARCHIVED"],
  DAMAGED: ["QUARANTINED", "ARCHIVED"],
  LOST: ["QUARANTINED", "ARCHIVED"],
  EMPTY: ["ARCHIVED"],
  ARCHIVED: [],
};

export function canTransitionContainer(from: ContainerStatus, to: ContainerStatus) {
  return allowedTransitions[from].includes(to);
}

export function assertContainerTransition(from: ContainerStatus, to: ContainerStatus) {
  if (!canTransitionContainer(from, to)) throw new Error(`Container transition ${from} -> ${to} is not allowed.`);
}
