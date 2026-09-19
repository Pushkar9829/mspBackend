import { asyncHandler } from "../../utils/asyncHandler.js";
import * as authService from "./service.js";
import * as ledger from "../ledger/service.js";

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
  const ledgerDoc = await ledger.getLedgerForUser(result.user.id, result.user.tenantId);
  result.user.ledgerBalance = ledgerDoc.balance;
  result.user.ledgerUpdatedAt = ledgerDoc.updatedAt;
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
  const user = authService.toPublicUser(req.user, req.role);
  const ledgerDoc = await ledger.getLedgerForUser(req.user._id, req.user.tenantId);
  res.json({ ...user, ledgerBalance: ledgerDoc.balance, ledgerUpdatedAt: ledgerDoc.updatedAt, ledgerEntries: ledgerDoc.entries });
});

export const forgotPassword = asyncHandler(async (req, res) => {
  const result = await authService.forgotPassword(req.body.email);
  res.json(result);
});

export const resetPassword = asyncHandler(async (req, res) => {
  await authService.resetPassword(req.body.token, req.body.password);
  res.json({ ok: true });
});

export const updateMe = asyncHandler(async (req, res) => {
  res.json(await authService.updateMe(req.user._id, req.body));
});

export const changePassword = asyncHandler(async (req, res) => {
  await authService.changePassword(
    req.user._id,
    req.body.currentPassword,
    req.body.newPassword
  );
  res.json({ ok: true });
});
