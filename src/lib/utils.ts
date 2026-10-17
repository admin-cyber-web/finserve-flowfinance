import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * "NOT_VERIFIED" → "Not Verified" — turns a vocabulary code (snake/upper
 * case, e.g. loan purpose or office-use status) into a display label.
 */
export function sentenceCase(value: string): string {
  return value
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/(^|\s)([a-z])/g, (_, prefix, char) => `${prefix}${char.toUpperCase()}`);
}
