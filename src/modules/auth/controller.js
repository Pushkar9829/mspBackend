import { asyncHandler } from "../../utils/asyncHandler.js";
import * as authService from "./service.js";

export const register = asyncHandler(async (req, res) => {
  const user = await authService.registerBuyer(req.body);
  res.status(201).json({
    id: user._id,
    email: user.email,
    status: user.status,
    message: "Account created.",
  });
});

export const login = asyncHandler(async (req, res) => {
  const result = await authService.login(req.body, res);
  res.json(result);
});

export const refresh = asyncHandler(async (req, res) => {
  const tokens = await authService.refresh(req, res);
  res.json(tokens);
});

export const logout = asyncHandler(async (req, res) => {
  await authService.logout(req, res);
  res.json({ ok: true });
});

export const me = asyncHandler(async (req, res) => {
  res.json(authService.toPublicUser(req.user, req.role));
});

export const forgotPassword = asyncHandler(async (req, res) => {
  const result = await authService.forgotPassword(req.body.email);
  res.json(result);
});

export const resetPassword = asyncHandler(async (req, res) => {
  await authService.resetPassword(req.body.token, req.body.password);
  res.json({ ok: true });
});

export const changePassword = asyncHandler(async (req, res) => {
  await authService.changePassword(
    req.user._id,
    req.body.currentPassword,
    req.body.newPassword
  );
  res.json({ ok: true });
});
