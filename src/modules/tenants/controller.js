import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";

export const list = asyncHandler(async (req, res) => {
  res.json(await service.listTenants(req.query));
});

export const get = asyncHandler(async (req, res) => {
  res.json(await service.getTenant(req.params.id));
});

export const create = asyncHandler(async (req, res) => {
  const tenant = await service.createTenant(req.body);
  res.status(201).json(tenant);
});

export const update = asyncHandler(async (req, res) => {
  res.json(await service.updateTenant(req.params.id, req.body));
});

export const getMine = asyncHandler(async (req, res) => {
  res.json(await service.getMyTenant(req));
});

export const updateMine = asyncHandler(async (req, res) => {
  res.json(await service.updateMyTenant(req, req.body));
});
