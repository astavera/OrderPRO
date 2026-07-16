import { randomBytes } from "node:crypto";

const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const bodyLength = 9;

function checksum(body: string) {
  let accumulator = 0;
  for (let index = 0; index < body.length; index += 1) {
    accumulator = (accumulator + alphabet.indexOf(body[index]) * (index + 1)) % alphabet.length;
  }
  return alphabet[accumulator];
}

export function generateBoxCode() {
  const bytes = randomBytes(bodyLength);
  let body = "";
  for (const byte of bytes) body += alphabet[byte % alphabet.length];
  return `BX-${body}${checksum(body)}`;
}

export function isValidBoxCode(value: string) {
  const normalized = value.trim().toUpperCase();
  if (!/^BX-[2-9A-HJ-NP-Z]{10}$/.test(normalized)) return false;
  const body = normalized.slice(3, -1);
  return normalized.at(-1) === checksum(body);
}
