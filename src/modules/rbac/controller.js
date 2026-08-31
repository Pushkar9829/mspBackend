import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";

export const listPermissions = asyncHandler(async (_req, res) => {
  res.json(await service.listPermissions());
});

export const listRoles = asyncHandler(async (req, res) => {
  res.json(await service.listRoles(req));
});

export const getRole = asyncHandler(async (req, res) => {
  res.json(await service.getRole(req, req.params.id));
});

export const createRole = asyncHandler(async (req, res) => {
  res.status(201).json(await service.createRole(req, req.body));
});

export const updateRole = asyncHandler(async (req, res) => {
  res.json(await service.updateRole(req, req.params.id, req.body));
});

export const deleteRole = asyncHandler(async (req, res) => {
  res.json(await service.deleteRole(req, req.params.id));
});
