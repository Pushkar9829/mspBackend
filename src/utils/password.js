import { z } from "zod";

/**
 * Policy for NEW passwords (register, seller register, reset, change, admin-created users):
 * 8-100 characters, at least one letter and one number, not a well-known common password.
 * Existing passwords are never re-checked (login uses its own schema).
 */
export const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "password12",
  "password123",
  "password1234",
  "passw0rd",
  "p@ssw0rd",
  "p@ssword1",
  "12345678",
  "123456789",
  "1234567890",
  "11111111",
  "00000000",
  "qwerty12",
  "qwerty123",
  "qwertyui",
  "1q2w3e4r",
  "1qaz2wsx",
  "zaq12wsx",
  "abc12345",
  "abcd1234",
  "abcdefg1",
  "admin123",
  "admin1234",
  "welcome1",
  "welcome123",
  "letmein1",
  "iloveyou1",
  "sunshine1",
  "monkey123",
  "football1",
  "changeme1",
  "test1234",
  "india123",
  "india@123",
]);

export const PASSWORD_HINT = "At least 8 characters with a letter and a number; avoid common passwords.";

export const newPassword = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(100)
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), "Password must contain at least one letter and one number")
  .refine((v) => !COMMON_PASSWORDS.has(v.toLowerCase()), "This password is too common. Choose a less guessable one.");
