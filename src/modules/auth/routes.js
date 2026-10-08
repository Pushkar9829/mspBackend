import { Router } from "express";
import { validate } from "../../middleware/validate.js";
import { authenticate, optionalAuth } from "../../middleware/authenticate.js";
import {
  loginLimiter,
  registerLimiter,
  forgotLimiter,
  resetLimiter,
  verifyLimiter,
  refreshLimiter,
  sensitiveLimiter,
} from "../../middleware/rateLimits.js";
import { audit } from "../../middleware/audit.js";
import * as ctrl from "./controller.js";
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
  forgotSchema,
  resetSchema,
  changePasswordSchema,
  updateMeSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  deleteMeSchema,
} from "./validators.js";

const router = Router();

router.post("/register", registerLimiter, validate(registerSchema), ctrl.register);
router.post("/login", audit("login", "auth"), loginLimiter, validate(loginSchema), ctrl.login);
router.post("/refresh", refreshLimiter, validate(refreshSchema), ctrl.refresh);
// No `authenticate`: logout must work after the access token expired (uses the refresh cookie/body).
router.post("/logout", audit("logout", "auth"), validate(logoutSchema), ctrl.logout);
router.post("/logout-all", audit("logout_all", "auth"), authenticate, ctrl.logoutAll);
router.post("/verify-email", verifyLimiter, validate(verifyEmailSchema), ctrl.verifyEmail);
router.post("/resend-verification", verifyLimiter, optionalAuth, validate(resendVerificationSchema), ctrl.resendVerification);
router.get("/me", authenticate, ctrl.me);
router.patch("/me", authenticate, validate(updateMeSchema), ctrl.updateMe);
router.get("/me/export", authenticate, sensitiveLimiter, ctrl.exportMe);
router.delete("/me", audit("delete_self", "user"), authenticate, sensitiveLimiter, validate(deleteMeSchema), ctrl.deleteMe);
router.post("/forgot-password", forgotLimiter, validate(forgotSchema), ctrl.forgotPassword);
router.post("/reset-password", audit("password_reset", "auth"), resetLimiter, validate(resetSchema), ctrl.resetPassword);
router.post(
  "/change-password",
  authenticate,
  sensitiveLimiter,
  audit("password_change", "auth"),
  validate(changePasswordSchema),
  ctrl.changePassword
);

export default router;
