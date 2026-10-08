import { asyncHandler } from "../../utils/asyncHandler.js";
import { logger } from "../../utils/logger.js";
import * as authService from "./service.js";
import * as ledger from "../ledger/service.js";

async function withLedger(publicUser, userId, tenantId) {
  try {
    const ledgerDoc = await ledger.getLedgerForUser(userId, tenantId);
    return { ...publicUser, ledgerBalance: ledgerDoc?.balance, ledgerUpdatedAt: ledgerDoc?.updatedAt, ledgerEntries: ledgerDoc?.entries };
  } catch (err) {
    logger.warn("ledger lookup failed", { err: err.message });
    return publicUser;
  }
}

export const register = asyncHandler(async (req, res) => {
  res.status(201).json(await authService.registerBuyer(req.body));
});

export const login = asyncHandler(async (req, res) => {
  const result = await authService.login(req.body, req, res);
  const { ledgerEntries: _e, ...user } = await withLedger(result.user, result.user.id, result.user.tenantId);
  res.json({ ...result, user });
});

export const refresh = asyncHandler(async (req, res) => {
  res.json(await authService.refresh(req, res));
});

export const logout = asyncHandler(async (req, res) => {
  await authService.logout(req, res);
  res.json({ ok: true });
});

export const logoutAll = asyncHandler(async (req, res) => {
  await authService.logoutAll(req.user._id, res);
  res.json({ ok: true });
});

export const me = asyncHandler(async (req, res) => {
  const user = authService.toPublicUser(req.user, req.role);
  res.json(await withLedger(user, req.user._id, req.user.tenantId?._id || req.user.tenantId || null));
});

export const forgotPassword = asyncHandler(async (req, res) => {
  res.json(await authService.forgotPassword(req.body.email));
});

export const resetPassword = asyncHandler(async (req, res) => {
  await authService.resetPassword(req.body.token, req.body.password);
  res.json({ ok: true });
});

export const verifyEmail = asyncHandler(async (req, res) => {
  res.json(await authService.verifyEmail(req.body.token));
});

export const resendVerification = asyncHandler(async (req, res) => {
  res.json(await authService.resendVerification({ user: req.user, email: req.body?.email }));
});

export const updateMe = asyncHandler(async (req, res) => {
  res.json(await authService.updateMe(req.user._id, req.body));
});

export const changePassword = asyncHandler(async (req, res) => {
  res.json(await authService.changePassword(req, res, req.body.currentPassword, req.body.newPassword));
});

export const exportMe = asyncHandler(async (req, res) => {
  res.setHeader("Content-Disposition", `attachment; filename="msp-account-export.json"`);
  res.json(await authService.exportMe(req));
});

export const deleteMe = asyncHandler(async (req, res) => {
  res.json(await authService.deleteMe(req, res, req.body.password));
});
