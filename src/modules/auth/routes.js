import { Router } from "express";
import { validate } from "../../middleware/validate.js";
import { authenticate } from "../../middleware/authenticate.js";
import { loginLimiter, resetLimiter } from "../../middleware/rateLimits.js";
import { audit } from "../../middleware/audit.js";
import * as ctrl from "./controller.js";
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  forgotSchema,
  resetSchema,
  changePasswordSchema,
} from "./validators.js";

const router = Router();

router.post("/register", validate(registerSchema), ctrl.register);
router.post("/login", loginLimiter, validate(loginSchema), audit("login", "auth"), ctrl.login);
router.post("/refresh", validate(refreshSchema), ctrl.refresh);
router.post("/logout", authenticate, ctrl.logout);
router.get("/me", authenticate, ctrl.me);
router.post("/forgot-password", resetLimiter, validate(forgotSchema), ctrl.forgotPassword);
router.post("/reset-password", resetLimiter, validate(resetSchema), ctrl.resetPassword);
router.post(
  "/change-password",
  authenticate,
  validate(changePasswordSchema),
  ctrl.changePassword
);

export default router;
