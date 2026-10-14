import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import * as service from "./service.js";

/** Status changes need tenants.suspend explicitly (not just tenants.edit). */
function assertCanChangeStatus(req) {
  const perms = req.permissions || [];
  if (!(perms.includes("*") || perms.includes("tenants.suspend"))) {
    throw new AppError(403, "Changing a store's status requires the tenants.suspend permission", "FORBIDDEN");
  }
}

export const list = asyncHandler(async (req, res) => {
  res.json(await service.listTenants(req.query));
});

export const get = asyncHandler(async (req, res) => {
  res.json(await service.presentTenantForAdmin(await service.getTenant(req.params.id), { withDocs: true }));
});

export const create = asyncHandler(async (req, res) => {
  if (req.body.status && req.body.status !== "pending" && req.body.status !== "active") assertCanChangeStatus(req);
  const tenant = await service.createTenant(req.body, { by: req.user?._id });
  res.status(201).json(await service.presentTenantForAdmin(tenant));
});

export const update = asyncHandler(async (req, res) => {
  if (req.body.status !== undefined) {
    const current = await service.getTenant(req.params.id);
    if (req.body.status !== current.status) assertCanChangeStatus(req);
  }
  res.json(
    await service.presentTenantForAdmin(await service.updateTenant(req.params.id, req.body, { by: req.user?._id, platformAdmin: req.isPlatformAdmin === true }))
  );
});

export const setStatus = asyncHandler(async (req, res) => {
  assertCanChangeStatus(req);
  const tenant = await service.setTenantStatus(req.params.id, req.body.status, { reason: req.body.reason, by: req.user?._id });
  res.json(await service.presentTenantForAdmin(tenant));
});

export const getMine = asyncHandler(async (req, res) => {
  const tenant = await service.getMyTenant(req);
  // Staff get their full store (with KYC flags); buyers get the public storefront card.
  res.json(tenant && tenant.businessProfile !== undefined ? service.presentTenant(tenant) : tenant);
});

export const updateMine = asyncHandler(async (req, res) => {
  res.json(service.presentTenant(await service.updateMyTenant(req, req.body)));
});

/** Seller: platform-admin access to their store. */
export const myAccessLog = asyncHandler(async (req, res) => {
  const tenantId = req.user?.tenantId?._id || req.user?.tenantId;
  if (!tenantId || req.isBuyer) throw new AppError(403, "Staff access required", "FORBIDDEN");
  res.json(await service.listAccessLog(tenantId, req.query));
});

/** Platform admin: access log of one store. */
export const accessLog = asyncHandler(async (req, res) => {
  res.json(await service.listAccessLog(req.params.id, req.query));
});
